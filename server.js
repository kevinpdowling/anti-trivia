const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files, but disable caching for HTML so the browser
// always fetches the latest version (important for the WebView2 plugin).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-store');
    }
  }
}));

// ── State ──────────────────────────────────────────────────────────────────
const teams = new Map(); // socketId → { name, score, answer }
const disconnected = new Map(); // name.toLowerCase() → { name, score, answer }
let currentQuestion = null; // { text, number } | null
let questionCount = 0;
const questionHistory = []; // all questions pushed so far
let displayMode = 'leaderboard'; // 'leaderboard' | 'answers'
const revealedAnswers = new Set(); // team names whose answers are shown on big screen
let highlightedTeam = null; // { name, answer } | null — drawing shown full screen

function teamsList() {
  return Array.from(teams.entries()).map(([id, t]) => ({ id, ...t }));
}

function broadcastLeaderboard() {
  const sorted = teamsList()
    .sort((a, b) => b.score - a.score)
    .map((t, i) => ({ rank: i + 1, name: t.name, score: t.score }));
  io.emit('leaderboard:update', sorted);
}

function broadcastAnswers() {
  const answers = teamsList().map(t => ({
    name: t.name,
    answer: t.answer,
    revealed: revealedAnswers.has(t.name),
  }));
  io.emit('display:answers', { question: currentQuestion, answers });
}

function broadcastHighlight() {
  io.emit('display:highlight', highlightedTeam);
}

function broadcastHostState() {
  io.to('host').emit('host:state', {
    teams: teamsList(),
    question: currentQuestion,
    questionHistory,
    displayMode,
    revealedAnswers: [...revealedAnswers],
    highlightedTeamName: highlightedTeam ? highlightedTeam.name : null,
  });
}

// ── Sockets ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // HOST
  socket.on('host:join', () => {
    socket.join('host');
    broadcastHostState();
  });

  socket.on('host:push-question', ({ text, type }) => {
    questionCount++;
    currentQuestion = { text: text.trim(), number: questionCount, type: type || 'text' };
    questionHistory.push(currentQuestion);
    revealedAnswers.clear();
    highlightedTeam = null;
    broadcastHighlight();
    for (const t of teams.values()) { t.answer = null; }
    io.to('teams').emit('question:new', currentQuestion);
    broadcastHostState();
    broadcastLeaderboard();
  });

  socket.on('host:clear-question', () => {
    currentQuestion = null;
    io.to('teams').emit('question:clear');
    broadcastHostState();
  });

  socket.on('host:award-points', ({ teamId, delta }) => {
    const t = teams.get(teamId);
    if (!t) return;
    t.score = Math.max(0, t.score + delta);
    broadcastLeaderboard();
    broadcastHostState();
  });

  socket.on('host:set-score', ({ teamId, score }) => {
    const t = teams.get(teamId);
    if (!t) return;
    t.score = Math.max(0, parseInt(score) || 0);
    broadcastLeaderboard();
    broadcastHostState();
  });

  socket.on('host:remove-team', ({ teamId }) => {
    teams.delete(teamId);
    broadcastLeaderboard();
    broadcastHostState();
  });

  socket.on('host:highlight-team', ({ teamName }) => {
    if (highlightedTeam && highlightedTeam.name === teamName) {
      highlightedTeam = null;
    } else {
      const t = teamsList().find(t => t.name === teamName);
      if (t) highlightedTeam = { name: t.name, answer: t.answer };
    }
    broadcastHighlight();
    broadcastHostState();
  });

  socket.on('host:reveal-answer', ({ teamName }) => {
    if (revealedAnswers.has(teamName)) revealedAnswers.delete(teamName);
    else revealedAnswers.add(teamName);
    broadcastAnswers();
    broadcastHostState();
  });

  socket.on('host:reset-game', () => {
    teams.clear();
    disconnected.clear();
    currentQuestion = null;
    questionCount = 0;
    questionHistory.length = 0;
    revealedAnswers.clear();
    highlightedTeam = null;
    displayMode = 'leaderboard';
    io.emit('game:reset');
    broadcastHighlight();
    broadcastLeaderboard();
    broadcastHostState();
  });

  socket.on('host:set-display', ({ mode }) => {
    displayMode = mode;
    io.emit('display:mode', mode);
    if (mode === 'answers') broadcastAnswers();
    else broadcastLeaderboard();
    broadcastHostState();
  });

  // TEAM
  socket.on('team:join', ({ name }) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return socket.emit('join:error', 'Please enter a team name.');
    if (trimmed.length > 30) return socket.emit('join:error', 'Name too long (max 30 chars).');
    const taken = Array.from(teams.values()).some(t => t.name.toLowerCase() === trimmed.toLowerCase());
    if (taken) return socket.emit('join:error', 'That name is already taken!');

    // Restore saved data if rejoining after a disconnect
    const saved = disconnected.get(trimmed.toLowerCase());
    if (saved) disconnected.delete(trimmed.toLowerCase());

    teams.set(socket.id, { name: trimmed, score: saved ? saved.score : 0, answer: saved ? saved.answer : null });
    socket.join('teams');
    socket.emit('join:success', { name: trimmed, question: currentQuestion });
    broadcastLeaderboard();
    broadcastHostState();
  });

  socket.on('team:submit', ({ answer }) => {
    const t = teams.get(socket.id);
    if (!t || !currentQuestion) return;
    t.answer = (answer || '').trim();
    socket.emit('submit:ack');
    broadcastHostState();
    if (displayMode === 'answers') broadcastAnswers();
  });

  // LEADERBOARD
  socket.on('leaderboard:join', () => {
    socket.join('leaderboard');
    socket.emit('display:mode', displayMode);
    socket.emit('display:highlight', highlightedTeam);
    broadcastLeaderboard();
    if (displayMode === 'answers') broadcastAnswers();
    if (currentQuestion) socket.emit('question:new', currentQuestion);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    if (teams.has(socket.id)) {
      const t = teams.get(socket.id);
      disconnected.set(t.name.toLowerCase(), { name: t.name, score: t.score, answer: t.answer });
      teams.delete(socket.id);
      broadcastLeaderboard();
      broadcastHostState();
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n  Trivia Night is running!\n');
  console.log('  Host dashboard  →  http://localhost:3000/host.html');
  console.log('  Leaderboard     →  http://localhost:3000/leaderboard.html');
  console.log('  Team join page  →  http://localhost:3000/signup.html\n');
  console.log('  For teams on the same WiFi, share your local IP instead of localhost.');
  console.log('  Find it by running: ipconfig\n');
});
