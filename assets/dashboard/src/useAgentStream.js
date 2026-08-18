/**
 * useAgentStream — Direct AgentCore SSE streaming with Cognito auth.
 *
 * Builds a structured "step" timeline as the agent works:
 *   [
 *     { type: 'lifecycle', phase: 'init' },
 *     { type: 'tool', toolName, toolId, input, result, rationale, learned },
 *     { type: 'lifecycle', phase: 'complete' },
 *   ]
 *
 * It also extracts blockquote rationale lines (`> Calling ...`, `> Learned: ...`)
 * the agent emits BEFORE/AFTER tool calls, and stitches them onto the matching
 * step so the UI can show "why" the tool was called and "what" was learned.
 * Those quote lines are stripped from the visible chat text so the final report
 * stays clean.
 */
import { useState, useCallback, useRef, useEffect } from 'react';

// ─── Config (from env vars at build time) ───────────────────────
const COGNITO_CLIENT_ID = process.env.REACT_APP_COGNITO_CLIENT_ID || '';
const AGENT_RUNTIME_ARN = process.env.REACT_APP_AGENT_RUNTIME_ARN || '';
const REGION = process.env.REACT_APP_REGION || 'us-west-2';
const COGNITO_AUTH_URL = `https://cognito-idp.${REGION}.amazonaws.com`;

// ─── Cognito Auth (USER_PASSWORD_AUTH flow) ─────────────────────

async function authenticateCognito(username, password) {
  const response = await fetch(COGNITO_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || 'Invalid credentials');
  }

  const data = await response.json();
  return data.AuthenticationResult.AccessToken;
}

// ─── SSE Event Parsing ───────────────────────────────────────────

function parseSSELine(line) {
  if (!line.startsWith('data: ')) return null;
  const payload = line.substring(6).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function classifyEvent(json) {
  if (!json) return null;

  // Text token (from Strands "data" field)
  if (typeof json.data === 'string') {
    return { type: 'text', content: json.data };
  }

  // Tool use start/delta
  if (json.current_tool_use) {
    const toolName = json.current_tool_use.name || 'unknown_tool';
    const toolId = json.current_tool_use.toolUseId || '';
    const input = json.delta?.toolUse?.input || '';
    if (!input) return { type: 'tool_start', toolName, toolId };
    return { type: 'tool_delta', toolName, toolId, input };
  }

  // Tool result
  if (json.message?.role === 'user' && json.message?.content) {
    const results = json.message.content
      .filter(b => b.toolResult)
      .map(b => ({
        toolId: b.toolResult.toolUseId,
        result: b.toolResult.content?.map(c => c.text || '').join('\n') || 'Done',
      }));
    if (results.length > 0) return { type: 'tool_result', results };
  }

  // Lifecycle
  if (json.init_event_loop) return { type: 'lifecycle', phase: 'init' };
  if (json.start_event_loop) return { type: 'lifecycle', phase: 'thinking' };
  if (json.complete) return { type: 'lifecycle', phase: 'complete' };
  if (json.result) return { type: 'result', stopReason: json.result.stop_reason || 'end_turn' };

  return null;
}

// ─── Reasoning extraction ────────────────────────────────────────
// The agent is prompted to emit two kinds of blockquote lines:
//   > Calling `tool_name` to <verb> <object> because <reason>.
//   > Learned: <insight>. <next step>.
//
// We pull those out of the streaming text, attach them to the right step,
// and strip them from the final visible message so the report stays clean.

const RATIONALE_RE = /^>\s*Calling\s+`?([a-zA-Z0-9_]+)`?[^.\n]*\.?/im;
const LEARNED_RE = /^>\s*Learned:\s*([^\n]+)/im;

function extractRationale(text) {
  // Returns the FIRST matched blockquote line + the remaining text without it.
  const lines = text.split('\n');
  let extracted = null;
  let kind = null;
  let toolHint = null;
  let keepLines = [];

  for (const line of lines) {
    if (extracted === null) {
      const callMatch = line.match(RATIONALE_RE);
      if (callMatch) {
        extracted = line.replace(/^>\s*/, '').trim();
        kind = 'rationale';
        toolHint = callMatch[1];
        continue;
      }
      const learnedMatch = line.match(LEARNED_RE);
      if (learnedMatch) {
        extracted = learnedMatch[1].trim();
        kind = 'learned';
        continue;
      }
    }
    keepLines.push(line);
  }
  return {
    extracted,
    kind,
    toolHint,
    remaining: keepLines.join('\n'),
  };
}

// ─── Main Hook ───────────────────────────────────────────────────

export function useAgentStream() {
  const [messages, setMessages] = useState([]);
  const [currentStreamText, setCurrentStreamText] = useState('');
  const [currentSteps, setCurrentSteps] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [sessionId] = useState(() => {
    // Session ID must be >= 33 chars for AgentCore
    return `fraud-dashboard-${crypto.randomUUID().replace(/-/g, '')}`;
  });
  const abortRef = useRef(null);

  // Auto-authenticate on mount
  useEffect(() => {
    const savedToken = localStorage.getItem('fraudAuthToken');
    const savedExpiry = localStorage.getItem('fraudAuthExpiry');
    if (savedToken && savedExpiry && Date.now() < parseInt(savedExpiry)) {
      setAuthToken(savedToken);
    }
  }, []);

  const login = useCallback(async (username, password) => {
    try {
      const token = await authenticateCognito(username, password);
      setAuthToken(token);
      localStorage.setItem('fraudAuthToken', token);
      localStorage.setItem('fraudAuthExpiry', String(Date.now() + 50 * 60 * 1000));
      setError(null);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    localStorage.removeItem('fraudAuthToken');
    localStorage.removeItem('fraudAuthExpiry');
    setMessages([]);
    setError(null);
  }, []);

  const cancelStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const clearChat = useCallback(() => {
    setMessages([]);
    setCurrentStreamText('');
    setCurrentSteps([]);
    setError(null);
  }, []);

  const sendMessage = useCallback(async (_, userMessage) => {
    if (!userMessage?.trim() || isStreaming) return;

    if (!authToken) {
      setError('Please log in to continue');
      return;
    }

    const userMsg = { role: 'user', content: userMessage, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);

    setCurrentStreamText('');
    setCurrentSteps([]);
    setError(null);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // Local state for stream processing
    let displayText = '';   // text shown in chat (rationale stripped)
    let pendingText = '';   // buffer to scan for rationale lines
    let steps = [];         // ordered list of timeline steps
    let pendingRationale = null; // rationale waiting to be attached to next tool

    const updateSteps = () => setCurrentSteps([...steps]);
    const updateText = () => setCurrentStreamText(displayText);

    // Find the most-recent in-flight tool step (no result yet)
    const lastOpenToolIdx = () => {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].type === 'tool' && !steps[i].result) return i;
      }
      return -1;
    };
    // Find the most-recent completed tool step (used for "Learned:")
    const lastCompletedToolIdx = () => {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].type === 'tool' && steps[i].result) return i;
      }
      return -1;
    };

    // Drain rationale lines from pending text whenever we cross a newline
    const drainRationale = () => {
      while (true) {
        const newlineIdx = pendingText.indexOf('\n');
        if (newlineIdx === -1) break;
        const line = pendingText.slice(0, newlineIdx + 1);
        pendingText = pendingText.slice(newlineIdx + 1);

        const callMatch = line.match(RATIONALE_RE);
        const learnedMatch = line.match(LEARNED_RE);

        if (callMatch) {
          // Stash rationale for the next tool_start
          pendingRationale = line.replace(/^>\s*/, '').trim();
          // Don't include this line in the visible text
          continue;
        }
        if (learnedMatch) {
          // Attach to most-recent completed tool
          const idx = lastCompletedToolIdx();
          if (idx >= 0) {
            steps[idx] = { ...steps[idx], learned: learnedMatch[1].trim() };
            updateSteps();
          }
          continue;
        }
        // Normal line — keep in display text
        displayText += line;
      }
    };

    try {
      // Build context prompt with conversation history
      let contextPrompt = userMessage;
      if (messages.length > 0) {
        const history = messages.slice(-4).map(m =>
          m.role === 'user'
            ? `User: ${m.content}`
            : `Agent: ${m.content.substring(0, 400)}${m.content.length > 400 ? '...' : ''}`
        ).join('\n\n');
        contextPrompt = `Previous conversation:\n---\n${history}\n---\n\nCurrent request: ${userMessage}`;
      }

      const encodedArn = encodeURIComponent(AGENT_RUNTIME_ARN);
      const url = `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${encodedArn}/invocations`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
        },
        body: JSON.stringify({
          prompt: contextPrompt,
          runtimeSessionId: sessionId,
        }),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        logout();
        setError('Session expired. Please log in again.');
        setIsStreaming(false);
        return;
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AgentCore error ${response.status}: ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          const json = parseSSELine(line);
          const event = classifyEvent(json);
          if (!event) continue;

          if (event.type === 'text') {
            pendingText += event.content;
            drainRationale();
            updateText();
          } else if (event.type === 'tool_start') {
            // Flush any remaining buffered text first so order is preserved
            if (pendingText) {
              const newlineIdx = pendingText.lastIndexOf('\n');
              if (newlineIdx === -1) {
                // No newline yet — keep buffering, agent may still emit a rationale
                // before sending tokens for the actual report.
              }
            }
            steps.push({
              type: 'tool',
              toolName: event.toolName,
              toolId: event.toolId,
              input: '',
              result: null,
              rationale: pendingRationale,
              learned: null,
              startedAt: Date.now(),
            });
            pendingRationale = null;
            updateSteps();
          } else if (event.type === 'tool_delta') {
            const idx = lastOpenToolIdx();
            if (idx >= 0) {
              steps[idx] = { ...steps[idx], input: (steps[idx].input || '') + event.input };
              updateSteps();
            }
          } else if (event.type === 'tool_result') {
            for (const r of event.results) {
              const idx = steps.findIndex(s => s.type === 'tool' && s.toolId === r.toolId && !s.result);
              if (idx >= 0) {
                steps[idx] = { ...steps[idx], result: r.result, completedAt: Date.now() };
              } else {
                // Result with no matching start — append as orphan
                steps.push({ type: 'tool', toolName: 'tool', toolId: r.toolId, input: '', result: r.result, rationale: null, learned: null });
              }
            }
            updateSteps();
          } else if (event.type === 'lifecycle') {
            steps.push({ type: 'lifecycle', phase: event.phase });
            updateSteps();
          }
        }
      }

      // Flush any remaining text in the buffer (no trailing newline)
      if (pendingText) {
        // Check if the trailing pending text starts a rationale we should suppress
        const callMatch = pendingText.match(RATIONALE_RE);
        const learnedMatch = pendingText.match(LEARNED_RE);
        if (callMatch || learnedMatch) {
          // It's a rationale line that never got terminated — drop it
        } else {
          displayText += pendingText;
        }
        pendingText = '';
        updateText();
      }

      if (displayText.trim()) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: displayText,
          steps: steps.length > 0 ? [...steps] : undefined,
          timestamp: Date.now(),
        }]);
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        if (displayText) {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: displayText + '\n\n[Cancelled]',
            steps: steps.length > 0 ? [...steps] : undefined,
            timestamp: Date.now(),
          }]);
        }
      } else {
        setError(err.message);
      }
    } finally {
      setIsStreaming(false);
      setCurrentStreamText('');
      setCurrentSteps([]);
      abortRef.current = null;
    }
  }, [isStreaming, authToken, sessionId, messages, logout]);

  return {
    messages,
    currentStreamText,
    currentSteps,
    isStreaming,
    error,
    sendMessage,
    cancelStream,
    clearChat,
    sessionId,
    isAuthenticated: !!authToken,
    login,
    logout,
  };
}
