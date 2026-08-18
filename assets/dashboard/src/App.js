import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentStream } from './useAgentStream';
import './App.css';

// ─── Time / timezone helpers ─────────────────────────────────────
const TIMEZONES = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'New York (ET)' },
  { value: 'America/Chicago', label: 'Chicago (CT)' },
  { value: 'America/Denver', label: 'Denver (MT)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PT)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET)' },
  { value: 'Asia/Kolkata', label: 'Mumbai (IST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
];

function getHourInZone(isoUtc, timezone) {
  // Returns the local hour (0-23) in the given IANA timezone for an ISO UTC timestamp.
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false,
    });
    // hour: 'numeric' may return '24' for midnight in some impls; normalise.
    const h = parseInt(fmt.format(new Date(isoUtc)), 10);
    return ((h % 24) + 24) % 24;
  } catch {
    return new Date(isoUtc).getUTCHours();
  }
}

function formatTimeInZone(isoUtc, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(isoUtc));
  } catch {
    return new Date(isoUtc).toISOString().slice(11, 16) + ' UTC';
  }
}

// Off-hours match — supports rollover ranges (e.g. 22 -> 05).
function isOffHours(hour, startHour, endHour) {
  if (startHour === endHour) return false;          // empty window
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // Rollover: e.g. 22..5 means 22,23,0,1,2,3,4
  return hour >= startHour || hour < endHour;
}

// Initial transaction data (matches DynamoDB seed data — timestamps in UTC)
const TRANSACTIONS = [
  { id: "TXN-7890", customer: "CUST-1122", name: "Alice Johnson", amount: 89,   avgOrder: 75,  timestamp: "2026-04-27T14:15:00Z", device: "iPhone (known)",  shipTo: "Chicago, IL",   category: "clothing",    paymentMethod: "saved_card", status: "normal" },
  { id: "TXN-7891", customer: "CUST-3344", name: "Bob Smith",     amount: 142,  avgOrder: 130, timestamp: "2026-04-27T10:30:00Z", device: "Laptop (known)",  shipTo: "Austin, TX",    category: "home_goods",  paymentMethod: "saved_card", status: "normal" },
  { id: "TXN-7892", customer: "CUST-2847", name: "Carol Davis",   amount: 4800, avgOrder: 120, timestamp: "2026-04-27T02:47:00Z", device: "Unknown device",  shipTo: "Miami, FL",     category: "electronics", paymentMethod: "saved_card", status: "normal" },
  { id: "TXN-7893", customer: "CUST-5566", name: "David Lee",     amount: 67,   avgOrder: 55,  timestamp: "2026-04-27T16:00:00Z", device: "iPad (known)",    shipTo: "Seattle, WA",   category: "books",       paymentMethod: "saved_card", status: "normal" },
  { id: "TXN-7894", customer: "CUST-7788", name: "Eva Martinez",  amount: 920,  avgOrder: 95,  timestamp: "2026-04-27T03:12:00Z", device: "Unknown device",  shipTo: "New York, NY",  category: "electronics", paymentMethod: "new_card",   status: "normal" },
  { id: "TXN-7895", customer: "CUST-9900", name: "Frank Wilson",  amount: 210,  avgOrder: 180, timestamp: "2026-04-27T11:45:00Z", device: "Android (known)", shipTo: "Denver, CO",    category: "sports",      paymentMethod: "saved_card", status: "normal" },
];

// Default rule configuration
const DEFAULT_RULES = {
  spendingThreshold: 4,
  unknownDeviceEnabled: true,
  offHoursEnabled: true,
  offHoursStart: 0,                  // 00:00
  offHoursEnd: 5,                    // 05:00
  offHoursTimezone: 'UTC',           // IANA timezone
  newPaymentMethodEnabled: true,
};

// ─── Rule evaluation ─────────────────────────────────────────────
function evaluateRules(txn, rules) {
  const ratio = txn.amount / txn.avgOrder;
  const triggered = [];

  if (ratio > rules.spendingThreshold) {
    triggered.push({ key: 'spending', label: `Spending ${ratio.toFixed(1)}x avg`, severity: 'high' });
  }
  if (rules.unknownDeviceEnabled && txn.device.toLowerCase().includes('unknown')) {
    triggered.push({ key: 'unknownDevice', label: 'Unknown device', severity: 'high' });
  }
  if (rules.offHoursEnabled) {
    const tz = rules.offHoursTimezone || 'UTC';
    const localHour = getHourInZone(txn.timestamp, tz);
    if (isOffHours(localHour, rules.offHoursStart, rules.offHoursEnd)) {
      triggered.push({
        key: 'offHours',
        label: `Off-hours (${formatTimeInZone(txn.timestamp, tz)} ${tz.split('/').pop()})`,
        severity: 'medium',
      });
    }
  }
  if (rules.newPaymentMethodEnabled && txn.paymentMethod === 'new_card') {
    triggered.push({ key: 'newPayment', label: 'New payment method', severity: 'medium' });
  }
  return triggered;
}

// ─── Risk Score Gauge (SVG) ──────────────────────────────────────
function RiskGauge({ transaction, rules }) {
  const triggered = evaluateRules(transaction, rules);

  // Risk scoring: high signals = 30, medium = 15, capped at 100
  let score = triggered.reduce((acc, sig) => acc + (sig.severity === 'high' ? 30 : 15), 0);
  if (transaction.status === 'held') score = 95;
  const clampedScore = Math.min(score, 100);

  const circumference = 2 * Math.PI * 36;
  const offset = circumference - (clampedScore / 100) * circumference;

  const getColor = (s) => {
    if (s >= 75) return '#f85149';
    if (s >= 50) return '#d29922';
    if (s >= 25) return '#58a6ff';
    return '#3fb950';
  };
  const getLabel = (s) => {
    if (s >= 75) return 'CRITICAL';
    if (s >= 50) return 'HIGH';
    if (s >= 25) return 'MEDIUM';
    return 'LOW';
  };

  const color = getColor(clampedScore);

  return (
    <div className="risk-gauge">
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle cx="44" cy="44" r="36" fill="none" stroke="rgba(48,54,61,0.4)" strokeWidth="6" />
        <circle
          cx="44" cy="44" r="36" fill="none"
          stroke={color} strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 44 44)"
          style={{ transition: 'stroke-dashoffset 0.8s ease, stroke 0.4s ease' }}
        />
        <text x="44" y="40" textAnchor="middle" fill={color} fontSize="18" fontWeight="700">
          {clampedScore}
        </text>
        <text x="44" y="56" textAnchor="middle" fill="#6e7681" fontSize="9" fontWeight="500">
          {getLabel(clampedScore)}
        </text>
      </svg>
    </div>
  );
}

// ─── Transaction Detail Card ─────────────────────────────────────
function TransactionCard({ transaction, rules }) {
  const signals = evaluateRules(transaction, rules);
  const isUnknownDevice = transaction.device.toLowerCase().includes('unknown');
  const isNewPayment = transaction.paymentMethod === 'new_card';

  return (
    <div className={`txn-card txn-card-${transaction.status}`}>
      <div className="txn-card-header">
        <div className="txn-card-info">
          <span className="txn-card-id">{transaction.id}</span>
          <span className="txn-card-name">{transaction.name}</span>
        </div>
        <RiskGauge transaction={transaction} rules={rules} />
      </div>

      <div className="txn-card-amount">
        <span className="txn-card-amount-value">${transaction.amount.toLocaleString()}</span>
        <span className="txn-card-amount-avg">avg ${transaction.avgOrder}</span>
      </div>

      <div className="txn-card-meta">
        <div className="txn-card-meta-item">
          <span className="meta-icon">🕐</span>
          <span>{formatTimeInZone(transaction.timestamp, rules.offHoursTimezone || 'UTC')}</span>
        </div>
        <div className="txn-card-meta-item">
          <span className="meta-icon">📱</span>
          <span className={isUnknownDevice ? 'text-warning' : ''}>{transaction.device}</span>
        </div>
        <div className="txn-card-meta-item">
          <span className="meta-icon">📦</span>
          <span>{transaction.shipTo}</span>
        </div>
        <div className="txn-card-meta-item">
          <span className="meta-icon">💳</span>
          <span className={isNewPayment ? 'text-warning' : ''}>{isNewPayment ? 'New card' : 'Saved card'}</span>
        </div>
      </div>

      {signals.length > 0 && (
        <div className="txn-card-signals">
          <div className="signals-header">⚠️ Risk Signals ({signals.length})</div>
          {signals.map((sig, idx) => (
            <div key={idx} className={`signal-item signal-${sig.severity}`}>
              <span className="signal-dot"></span>
              <span className="signal-label">{sig.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tool Call Card (replaces flat timeline step) ─────────────────
function ToolCallCard({ event, rationale, isActive }) {
  const [expanded, setExpanded] = useState(false);

  // Pretty-print the JSON args/result if possible
  const formatPayload = (raw) => {
    if (!raw) return '';
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(raw).length > 600 ? String(raw).slice(0, 600) + '…' : String(raw);
    }
  };

  const friendlyName = (name) => {
    if (!name) return 'tool';
    return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  return (
    <div className={`tool-call-card ${isActive ? 'tool-call-card-active' : 'tool-call-card-done'}`}>
      <div className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-call-icon">🔧</span>
        <span className="tool-call-name">{friendlyName(event.toolName)}</span>
        {isActive && (
          <span className="tool-call-status">
            <span className="typing-indicator"><span></span><span></span><span></span></span>
          </span>
        )}
        {!isActive && <span className="tool-call-status-done">✓</span>}
        <span className="tool-call-chevron">{expanded ? '▾' : '▸'}</span>
      </div>

      {rationale && (
        <div className="tool-call-rationale">
          <span className="rationale-icon">💭</span>
          <span>{rationale}</span>
        </div>
      )}

      {expanded && (
        <div className="tool-call-details">
          {event.input && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">Input</div>
              <pre className="tool-call-payload">{formatPayload(event.input)}</pre>
            </div>
          )}
          {event.result && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">Result</div>
              <pre className="tool-call-payload">{formatPayload(event.result)}</pre>
            </div>
          )}
        </div>
      )}

      {event.learned && (
        <div className="tool-call-learned">
          <span className="rationale-icon">✨</span>
          <span>{event.learned}</span>
        </div>
      )}
    </div>
  );
}

// ─── Investigation Timeline ──────────────────────────────────────
function InvestigationTimeline({ steps, isActive }) {
  if (!steps || steps.length === 0) return null;

  return (
    <div className="investigation-timeline">
      {steps.map((step, idx) => {
        if (step.type === 'lifecycle') {
          const labels = { init: 'Investigation started', thinking: 'Analyzing signals', complete: 'Investigation complete' };
          const icons = { init: '🚀', thinking: '🧠', complete: '✅' };
          return (
            <div key={idx} className="timeline-lifecycle">
              <span className="lifecycle-icon">{icons[step.phase] || '⚡'}</span>
              <span className="lifecycle-label">{labels[step.phase] || 'Processing'}</span>
            </div>
          );
        }
        if (step.type === 'tool') {
          const isLast = idx === steps.length - 1;
          return (
            <ToolCallCard
              key={idx}
              event={step}
              rationale={step.rationale}
              isActive={isActive && isLast && !step.result}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

// ─── Markdown content renderer ───────────────────────────────────
function MessageMarkdown({ content }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Tweak link rendering so they open in new tabs
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ─── Chat Message Component ──────────────────────────────────────
function ChatMessage({ message }) {
  const isUser = message.role === 'user';

  return (
    <div className={`chat-message ${isUser ? 'chat-message-user' : 'chat-message-assistant'}`}>
      <div className="chat-message-avatar">
        {isUser ? '👤' : '🛡️'}
      </div>
      <div className="chat-message-body">
        {!isUser && message.steps && message.steps.length > 0 && (
          <InvestigationTimeline steps={message.steps} isActive={false} />
        )}
        <div className="chat-message-content">
          {isUser
            ? <pre>{message.content}</pre>
            : <MessageMarkdown content={message.content} />
          }
        </div>
        <div className="chat-message-time">
          {new Date(message.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Streaming Indicator ─────────────────────────────────────────
function StreamingIndicator({ text, steps }) {
  return (
    <div className="chat-message chat-message-assistant chat-message-streaming">
      <div className="chat-message-avatar">🛡️</div>
      <div className="chat-message-body">
        {steps && steps.length > 0 && (
          <InvestigationTimeline steps={steps} isActive={true} />
        )}
        {text ? (
          <div className="chat-message-content">
            <MessageMarkdown content={text} />
            <span className="cursor-blink">▊</span>
          </div>
        ) : (!steps || steps.length === 0) ? (
          <div className="chat-typing">
            <span className="typing-indicator">
              <span></span><span></span><span></span>
            </span>
            <span className="typing-label">Agent is investigating...</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Chat Panel Component ────────────────────────────────────────
function ChatPanel({ selectedTxn, selectedTransaction, onTransactionHeld, rules, agentStream }) {
  const {
    messages,
    currentStreamText,
    currentSteps,
    isStreaming,
    error,
    sendMessage,
    cancelStream,
    clearChat,
  } = agentStream;

  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  // Remember which assistant message we've already auto-held against, so
  // changing selectedTxn (clicking another row) doesn't re-fire the hold.
  const lastAutoHeldRef = useRef({ msgIndex: -1, txn: null });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentStreamText, currentSteps]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [selectedTxn]);

  useEffect(() => {
    if (messages.length === 0 || !selectedTxn) return;

    const lastIdx = messages.length - 1;
    const lastMsg = messages[lastIdx];
    if (lastMsg.role !== 'assistant') return;

    // Only auto-hold once per (assistant message, transaction) pair.
    if (lastAutoHeldRef.current.msgIndex === lastIdx &&
        lastAutoHeldRef.current.txn === selectedTxn) return;

    // Prefer a deterministic signal: did the agent invoke hold_transaction?
    const usedHoldTool = (lastMsg.steps || []).some(
      s => s.type === 'tool' && /hold[_-]?transaction/i.test(s.toolName || '')
    );

    // Fallback to keyword match in the report text (kept for resilience).
    const text = (lastMsg.content || '').toLowerCase();
    const reportSaysHold =
      /\b(transaction\s+held|hold(ing)?\s+the\s+transaction|placed\s+(a\s+)?hold|blocked\s+the\s+transaction|frozen)\b/.test(text);

    if (usedHoldTool || reportSaysHold) {
      onTransactionHeld(selectedTxn);
      lastAutoHeldRef.current = { msgIndex: lastIdx, txn: selectedTxn };
    }
  }, [messages, selectedTxn, onTransactionHeld]);

  const handleSend = () => {
    if (!inputValue.trim() || isStreaming) return;
    sendMessage(null, inputValue);
    setInputValue('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleQuickInvestigate = () => {
    if (!selectedTxn || isStreaming) return;
    const p = `Investigate flagged transaction ${selectedTxn} and determine if this is fraudulent. Check transaction details, customer profile, login activity, support history, and fraud playbooks.`;
    sendMessage(null, p);
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-header-icon">🛡️</span>
          <div>
            <div className="chat-header-title">Fraud Investigation Agent</div>
            <div className="chat-header-subtitle">
              {isStreaming ? (
                <><span className="pulse-dot"></span> Investigating...</>
              ) : (
                'Powered by MCP + Bedrock AgentCore'
              )}
            </div>
          </div>
        </div>
        <button className="btn-clear-chat" onClick={clearChat} title="Clear conversation">
          🗑️
        </button>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && !isStreaming && (
          <div className="chat-empty">
            {selectedTransaction ? (
              <>
                <TransactionCard transaction={selectedTransaction} rules={rules} />
                <button className="btn-quick-investigate" onClick={handleQuickInvestigate}>
                  🔍 Investigate {selectedTxn}
                </button>
                <div className="chat-suggestions">
                  <button className="suggestion-chip" onClick={() => setInputValue(`What are the risk signals for ${selectedTxn}?`)}>
                    Risk signals
                  </button>
                  <button className="suggestion-chip" onClick={() => setInputValue(`Check login history for suspicious activity`)}>
                    Login history
                  </button>
                  <button className="suggestion-chip" onClick={() => setInputValue(`What does the fraud playbook recommend?`)}>
                    Fraud playbook
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="chat-empty-icon">🔍</div>
                <h3>Select a Transaction</h3>
                <p>Click a row in the table to view risk details and start an investigation.</p>
              </>
            )}
          </div>
        )}

        {messages.map((msg, idx) => (
          <ChatMessage key={idx} message={msg} />
        ))}

        {isStreaming && (
          <StreamingIndicator text={currentStreamText} steps={currentSteps} />
        )}

        {error && (
          <div className="chat-error"><span>⚠️ {error}</span></div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        {isStreaming && (
          <button className="btn-stop-streaming" onClick={cancelStream}>⏹ Stop</button>
        )}
        <div className="chat-input-wrapper">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'Agent is responding...' : selectedTxn ? `Ask about ${selectedTxn}...` : 'Select a transaction first...'}
            disabled={isStreaming}
            rows={1}
          />
          <button className="btn-send" onClick={handleSend} disabled={isStreaming || !inputValue.trim()} title="Send (Enter)">
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Login Screen ────────────────────────────────────────────────
function LoginScreen({ onLogin, error }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    setSubmitting(true);
    const ok = await onLogin(username.trim(), password);
    setSubmitting(false);
    if (!ok) setPassword('');
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">🛡️</div>
          <h1>ShopSmart</h1>
          <p>Fraud Alert Dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label>Email</label>
            <input
              type="email"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="fraud-admin@workshop.aws"
              autoComplete="username"
              required
              autoFocus
            />
          </div>

          <div className="login-field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <div className="login-error">⚠️ {error}</div>
          )}

          <button type="submit" className="login-submit" disabled={submitting}>
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="login-footer">
          Powered by Amazon Bedrock AgentCore
        </div>
      </div>
    </div>
  );
}

// ─── Rules Panel ─────────────────────────────────────────────────
function RulesPanel({ rules, setRules, onApply, flaggedCount, rulesApplied }) {
  const updateRule = (key, value) => setRules(prev => ({ ...prev, [key]: value }));

  return (
    <div className="rules-panel">
      <p className="rules-description">
        Configure detection rules. A transaction is flagged when <strong>any enabled rule</strong> fires.
      </p>

      <div className="rule-row">
        <label className="rule-label">
          <input type="checkbox" checked readOnly />
          <span><strong>Spending anomaly</strong> &mdash; amount &gt; <span className="rule-pill">{rules.spendingThreshold}x</span> avg order</span>
        </label>
        <input
          type="range" min="2" max="20"
          value={rules.spendingThreshold}
          onChange={e => updateRule('spendingThreshold', Number(e.target.value))}
          className="rule-slider"
        />
      </div>

      <div className="rule-row">
        <label className="rule-label">
          <input
            type="checkbox"
            checked={rules.unknownDeviceEnabled}
            onChange={e => updateRule('unknownDeviceEnabled', e.target.checked)}
          />
          <span><strong>Unknown device</strong> &mdash; transaction from unrecognized device fingerprint</span>
        </label>
      </div>

      <div className="rule-row rule-row-offhours">
        <label className="rule-label">
          <input
            type="checkbox"
            checked={rules.offHoursEnabled}
            onChange={e => updateRule('offHoursEnabled', e.target.checked)}
          />
          <span><strong>Off-hours transaction</strong> &mdash; activity inside the time window below</span>
        </label>
        <div className="rule-offhours-inputs">
          <label className="rule-inline-label">
            From
            <input
              type="number" min="0" max="23"
              value={rules.offHoursStart}
              disabled={!rules.offHoursEnabled}
              onChange={e => updateRule('offHoursStart', Math.max(0, Math.min(23, Number(e.target.value) || 0)))}
              className="rule-num-input"
            />
            :00
          </label>
          <label className="rule-inline-label">
            To
            <input
              type="number" min="0" max="23"
              value={rules.offHoursEnd}
              disabled={!rules.offHoursEnabled}
              onChange={e => updateRule('offHoursEnd', Math.max(0, Math.min(23, Number(e.target.value) || 0)))}
              className="rule-num-input"
            />
            :00
          </label>
          <label className="rule-inline-label">
            TZ
            <select
              value={rules.offHoursTimezone}
              disabled={!rules.offHoursEnabled}
              onChange={e => updateRule('offHoursTimezone', e.target.value)}
              className="rule-tz-select"
            >
              {TIMEZONES.map(tz => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </label>
        </div>
        {rules.offHoursStart >= rules.offHoursEnd && rules.offHoursEnabled && (
          <span className="rule-hint">
            Window crosses midnight: <span className="rule-pill">{rules.offHoursStart}:00</span> &rarr; <span className="rule-pill">{rules.offHoursEnd}:00</span>
          </span>
        )}
      </div>

      <div className="rule-row">
        <label className="rule-label">
          <input
            type="checkbox"
            checked={rules.newPaymentMethodEnabled}
            onChange={e => updateRule('newPaymentMethodEnabled', e.target.checked)}
          />
          <span><strong>New payment method</strong> &mdash; first-time card not on file</span>
        </label>
      </div>

      <div className="rule-actions">
        <button className="btn-apply" onClick={onApply}>Apply rules</button>
        {rulesApplied && (
          <span className="rules-result">✓ {flaggedCount} transaction{flaggedCount === 1 ? '' : 's'} flagged</span>
        )}
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────
function App() {
  const agentStream = useAgentStream();
  const { isAuthenticated, login, logout, error: authError } = agentStream;

  const [transactions, setTransactions] = useState(TRANSACTIONS);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [rulesApplied, setRulesApplied] = useState(false);
  const [selectedTxn, setSelectedTxn] = useState(null);
  const [showRules, setShowRules] = useState(false);

  const handleTransactionHeld = useCallback((txnId) => {
    setTransactions(prev =>
      prev.map(t => t.id === txnId ? { ...t, status: 'held' } : t)
    );
  }, []);

  const handleReleaseHold = useCallback((txnId) => {
    setTransactions(prev =>
      prev.map(t => {
        if (t.id !== txnId) return t;
        // Re-evaluate against current rules to decide if it goes back to flagged or normal
        const triggered = evaluateRules(t, rules);
        return { ...t, status: triggered.length > 0 ? 'flagged' : 'normal' };
      })
    );
  }, [rules]);

  // Show login screen if not authenticated (all hooks called above)
  if (!isAuthenticated) {
    return <LoginScreen onLogin={login} error={authError} />;
  }

  const selectedTransaction = transactions.find(t => t.id === selectedTxn);

  const applyRules = () => {
    const updated = transactions.map(txn => {
      if (txn.status === 'held') return txn;
      const triggered = evaluateRules(txn, rules);
      return { ...txn, status: triggered.length > 0 ? 'flagged' : 'normal' };
    });
    setTransactions(updated);
    setRulesApplied(true);
  };

  const flaggedCount = transactions.filter(t => t.status === 'flagged').length;
  const heldCount = transactions.filter(t => t.status === 'held').length;
  const normalCount = transactions.filter(t => t.status === 'normal').length;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">🛡️ ShopSmart</div>
          <h1>Fraud Alert Dashboard</h1>
        </div>
        <div className="stats">
          <div className="stat normal-stat">
            <span className="stat-number">{normalCount}</span>
            <span className="stat-label">Normal</span>
          </div>
          <div className="stat flagged-stat">
            <span className="stat-number">{flaggedCount}</span>
            <span className="stat-label">Flagged</span>
          </div>
          <div className="stat held-stat">
            <span className="stat-number">{heldCount}</span>
            <span className="stat-label">Held</span>
          </div>
          <button className="btn-logout" onClick={logout} title="Sign out">
            ↪
          </button>
        </div>
      </header>

      <div className="main-content">
        <div className="left-panel">
          <div className="rules-section">
            <button className="btn-toggle-rules" onClick={() => setShowRules(!showRules)}>
              ⚙️ {showRules ? 'Hide' : 'Configure'} Flagging Rules
            </button>
            {showRules && (
              <RulesPanel
                rules={rules}
                setRules={setRules}
                onApply={applyRules}
                flaggedCount={flaggedCount}
                rulesApplied={rulesApplied}
              />
            )}
          </div>

          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Avg</th>
                  <th>Ratio</th>
                  <th>Time</th>
                  <th>Device</th>
                  <th>Payment</th>
                  <th>Ship To</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(txn => {
                  const isNewPay = txn.paymentMethod === 'new_card';
                  return (
                    <tr
                      key={txn.id}
                      className={`row-${txn.status} ${selectedTxn === txn.id ? 'selected' : ''}`}
                      onClick={() => setSelectedTxn(txn.id)}
                    >
                      <td className="txn-id">{txn.id}</td>
                      <td>{txn.name}</td>
                      <td className="amount">${txn.amount.toLocaleString()}</td>
                      <td>${txn.avgOrder}</td>
                      <td className="ratio">
                        <span className={txn.amount / txn.avgOrder > rules.spendingThreshold ? 'ratio-high' : ''}>
                          {(txn.amount / txn.avgOrder).toFixed(1)}x
                        </span>
                      </td>
                      <td>{formatTimeInZone(txn.timestamp, rules.offHoursTimezone || 'UTC')}</td>
                      <td className={txn.device.includes('Unknown') ? 'device-unknown' : ''}>{txn.device}</td>
                      <td>
                        <span className={`payment-chip ${isNewPay ? 'payment-new' : 'payment-saved'}`}>
                          {isNewPay ? 'New' : 'Saved'}
                        </span>
                      </td>
                      <td>{txn.shipTo}</td>
                      <td>
                        <span
                          className={`badge badge-${txn.status} ${txn.status === 'held' ? 'badge-clickable' : ''}`}
                          onClick={txn.status === 'held' ? (e) => { e.stopPropagation(); handleReleaseHold(txn.id); } : undefined}
                          title={txn.status === 'held' ? 'Click to release hold' : ''}
                        >
                          {txn.status === 'held' ? '🔴 HELD ↺' : txn.status === 'flagged' ? '🟡 FLAGGED' : '🟢 NORMAL'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="right-panel">
          <ChatPanel
            selectedTxn={selectedTxn}
            selectedTransaction={selectedTransaction}
            onTransactionHeld={handleTransactionHeld}
            rules={rules}
            agentStream={agentStream}
          />
        </div>
      </div>

      <footer className="footer">
        <span>MCP in Action: AI-Powered E-Commerce Fraud Investigation</span>
        <span>Powered by Amazon Bedrock AgentCore</span>
      </footer>
    </div>
  );
}

export default App;
