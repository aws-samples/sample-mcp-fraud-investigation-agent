"""
MCP in Action: AI-Powered Fraud Investigation Agent
Deployed on Amazon Bedrock AgentCore Runtime using Strands Agents SDK.

This agent:
1. Discovers MCP tools automatically from AgentCore Gateway
2. Uses a built-in tool to search Bedrock Knowledge Base for fraud playbooks
3. Correlates anomaly signals and takes protective action
4. Streams real-time investigation progress via SSE (tool calls visible to dashboard)
"""

import os
import json
import traceback
import boto3
import requests
from strands import Agent, tool
from strands.models.bedrock import BedrockModel
from strands.tools.mcp import MCPClient
from mcp.client.streamable_http import streamablehttp_client
from bedrock_agentcore.runtime import BedrockAgentCoreApp

# -----------------------------------------------------------------
# Environment configuration (injected by CloudFormation/Runtime)
# -----------------------------------------------------------------
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
GATEWAY_URL = os.environ.get("GATEWAY_URL", "")
KNOWLEDGE_BASE_ID = os.environ.get("KNOWLEDGE_BASE_ID", "")
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")

COGNITO_DOMAIN = os.environ.get("COGNITO_DOMAIN", "")
COGNITO_CLIENT_ID = os.environ.get("COGNITO_CLIENT_ID", "")
COGNITO_CLIENT_SECRET = os.environ.get("COGNITO_CLIENT_SECRET", "")
COGNITO_SCOPE = os.environ.get("COGNITO_SCOPE", "")

bedrock_agent_runtime = boto3.client("bedrock-agent-runtime", region_name=AWS_REGION)


# -----------------------------------------------------------------
# MCP Gateway access token (Cognito OAuth2 client credentials flow)
# -----------------------------------------------------------------
def get_gateway_token() -> str:
    """Fetch an OAuth2 access token to call the AgentCore Gateway."""
    token_url = f"https://{COGNITO_DOMAIN}/oauth2/token"
    response = requests.post(
        token_url,
        data={
            "grant_type": "client_credentials",
            "client_id": COGNITO_CLIENT_ID,
            "client_secret": COGNITO_CLIENT_SECRET,
            "scope": COGNITO_SCOPE,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


# -----------------------------------------------------------------
# Built-in tool: Fraud Playbook search (Bedrock KB)
# -----------------------------------------------------------------
@tool
def search_fraud_playbooks(query: str) -> str:
    """Search fraud detection playbooks and response procedures
    using the Bedrock Knowledge Base.

    Args:
        query: Natural language query about fraud patterns,
            response procedures, or investigation protocols.

    Returns:
        Relevant fraud playbook content including detection rules,
        confidence levels, and required actions.
    """
    try:
        response = bedrock_agent_runtime.retrieve(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            retrievalQuery={"text": query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {"numberOfResults": 3}
            },
        )
        results = []
        for r in response.get("retrievalResults", []):
            content = r.get("content", {}).get("text", "")
            score = r.get("score", 0)
            source = (
                r.get("location", {})
                .get("s3Location", {})
                .get("uri", "unknown")
            )
            results.append(f"[Score: {score:.2f}] Source: {source}\n{content}")
        if results:
            return "\n\n---\n\n".join(results)
        return "No relevant fraud playbooks found for this query."
    except Exception as e:
        return f"Error searching fraud playbooks: {str(e)}"


# -----------------------------------------------------------------
# System prompt
# -----------------------------------------------------------------
SYSTEM_PROMPT = """You are an AI Fraud Investigation Agent for ShopSmart, an e-commerce company.

Your role is to investigate flagged transactions by:
1. Gathering transaction details, customer profiles, and login activity using MCP tools
2. Checking customer support case history for prior fraud incidents
3. Consulting fraud playbooks via the Knowledge Base for response procedures
4. Correlating all signals to determine fraud confidence level
5. Taking protective action (holding transactions) when warranted

## Investigation Process

- Always start by getting the transaction details
- Then gather customer profile and login activity
- Check support case history for prior incidents
- Consult fraud playbooks with your findings
- Identify all anomaly signals and classify the threat
- Take action based on playbook recommendations

## Show Your Reasoning (IMPORTANT)

This investigation is observed live by analysts learning how the agent thinks.
You MUST narrate your reasoning so they can follow along:

1. **Before each tool call**, write a single line in this exact format:
   `> Calling \\`<tool_name>\\` to <verb> <object> because <reason>.`
   Example:
   `> Calling \\`get_login_activity\\` to retrieve recent logins for CUST-2847 because the transaction came from an unknown device at 2:47 AM.`

2. **After each tool result**, write a single line in this exact format:
   `> Learned: <one-sentence insight>. <Optional next step>.`
   Example:
   `> Learned: Password was changed from a VPN IP 2 hours before the transaction — strong account-takeover signal. Checking support history next.`

3. Keep these reasoning lines concise — one sentence each. Place them on their own line, prefixed with `> ` (markdown blockquote).

## Final Report Format

When the investigation is complete, output a markdown report with these sections:

```
## Investigation Summary

**Transaction:** TXN-XXXX  |  **Customer:** CUST-XXXX (Name)
**Classification:** ACCOUNT TAKEOVER | CARD NOT PRESENT | SYNTHETIC IDENTITY | ...
**Confidence:** LOW | MEDIUM | HIGH | CRITICAL
**Fraud Score:** XX / 100

## Anomaly Signals (N detected)

- **Spending anomaly** — $X vs avg $Y (Zx)
- **Device anomaly** — unknown device fingerprint
- **Geographic anomaly** — Miami shipping vs Chicago profile
- ...

## Action Taken

- Transaction held / released / flagged for manual review
- Customer notified via email
- ...

## Recommendation

One or two sentences on next steps.
```

Use proper markdown: bold for labels, bullet lists for signals, headings for sections.
Be thorough but concise. Correlate signals across systems.
"""


# -----------------------------------------------------------------
# AgentCore Runtime app — Streaming entrypoint
# -----------------------------------------------------------------
app = BedrockAgentCoreApp()


@app.entrypoint
async def invoke(payload):
    """
    AgentCore Runtime streaming entrypoint.

    Yields SSE events as the agent processes the investigation.
    The frontend reads these events in real-time to show:
    - Tool calls as they happen (get_transaction_details, etc.)
    - Agent reasoning tokens
    - Final investigation report

    Uses agent.stream_async() for true token-level streaming.
    """
    user_input = payload.get("prompt", "")
    session_id = payload.get("runtimeSessionId", "")

    if not user_input:
        yield {"error": "No prompt provided"}
        return

    try:
        print(f"[AGENT] Starting streaming invocation, session: {session_id}")
        print(f"[AGENT] Query: {user_input[:100]}...")

        # Get Gateway token and create MCP client
        token = get_gateway_token()

        def create_transport():
            return streamablehttp_client(
                GATEWAY_URL,
                headers={"Authorization": f"Bearer {token}"},
            )

        mcp_client = MCPClient(create_transport)

        with mcp_client:
            # Auto-discover all MCP tools from the Gateway
            mcp_tools = mcp_client.list_tools_sync()
            print(f"[AGENT] Discovered {len(list(mcp_tools))} MCP tools")

            # Combine MCP tools + built-in KB tool
            all_tools = list(mcp_tools) + [search_fraud_playbooks]

            model = BedrockModel(
                model_id=BEDROCK_MODEL_ID,
                region_name=AWS_REGION,
            )
            agent = Agent(
                model=model,
                tools=all_tools,
                system_prompt=SYSTEM_PROMPT,
            )

            # Stream all events — yields text tokens, tool calls, results
            async for event in agent.stream_async(user_input):
                yield json.loads(json.dumps(dict(event), default=str))

    except Exception as e:
        print(f"[AGENT ERROR] {e}")
        traceback.print_exc()
        yield {"error": str(e)}


if __name__ == "__main__":
    app.run()
