# AgentCore Runtime requires ARM64 + Python + port 8080
FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

# Install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the agent code
COPY agent.py .

# AgentCore Runtime contract
EXPOSE 8080

# Start the agent HTTP server (BedrockAgentCoreApp handles
# /invocations POST and /ping GET automatically)
CMD ["python", "agent.py"]
