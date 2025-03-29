const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Accounts persistent in JSON speichern ---
const accountsFile = './accounts.json';
let accounts = {};

function loadAccounts() {
  if (fs.existsSync(accountsFile)) {
    try {
      return JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    } catch (err) {
      console.error("Fehler beim Lesen der Accounts:", err);
      return {};
    }
  }
  return {};
}
function saveAccounts() {
  fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2), 'utf8');
}
accounts = loadAccounts();

// Globales Set für aktuell eingeloggte Nutzer
let loggedInUsers = new Set();

// --- Kartenspiel-Funktionen ---
function createDeck() {
  const suits = ["Kreuz", "Pik", "Herz", "Karo"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "Unter", "Ober", "König", "Ass"];
  let deck = [];
  suits.forEach(suit => {
    ranks.forEach(rank => {
      deck.push({ rank, suit });
    });
  });
  return deck;
}
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// Initialisiert den Spielzustand in einer Lobby – nur mit den aktuell in der Lobby befindlichen Spielern
function initializeGame(players) {
  let deck = createDeck();
  shuffle(deck);
  const hands = {};
  const drawnAfterPenalty = {};
  const initialHandSize = 5;
  players.forEach(player => {
    hands[player] = [];
    drawnAfterPenalty[player] = false;
    for (let i = 0; i < initialHandSize; i++) {
      hands[player].push(deck.pop());
    }
  });
  let firstCard = deck.pop();
  return {
    deck: deck,
    discardPile: [firstCard],
    hands: hands,
    turnOrder: players,
    currentTurnIndex: 0,
    penaltyCount: 0,
    skipNext: false,
    activeSuit: null,
    drawnAfterPenalty: drawnAfterPenalty,
    lastInteraction: Date.now()
  };
}

// Globale Lobbies (im Arbeitsspeicher)
let lobbies = [];

// Versendet die aktuelle Lobbyliste (inkl. Elo) an alle Clients
function emitLobbyList() {
  io.emit('lobbyList', lobbies.map(lobby => {
    let lobbyCopy = { ...lobby };
    lobbyCopy.playerElos = {};
    lobby.players.forEach(player => {
      lobbyCopy.playerElos[player] = accounts[player] ? accounts[player].elo : 1000;
    });
    return lobbyCopy;
  }));
}

// --- Routen ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});
app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// Logout: Entfernt den Nutzer aus allen Lobbies und aus loggedInUsers
app.get('/logout', (req, res) => {
  const username = req.query.username;
  if (username) {
    lobbies = lobbies.filter(lobby => {
      if (lobby.players.includes(username)) {
        if (lobby.host === username) {
          io.to(lobby.id).emit('errorMessage', 'Der Host hat die Lobby verlassen.');
          return false;
        } else {
          lobby.players = lobby.players.filter(player => player !== username);
          return true;
        }
      }
      return true;
    });
    loggedInUsers.delete(username);
    emitLobbyList();
  }
  res.redirect('/login');
});

// Registrierung
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (accounts[username]) {
    return res.send("Username existiert bereits.");
  }
  accounts[username] = { password, elo: 1000 };
  saveAccounts();
  res.redirect('/login');
});

// Login: Prüft, ob der Nutzer bereits eingeloggt ist
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (accounts[username] && accounts[username].password === password) {
    if (loggedInUsers.has(username)) {
      return res.send("Dieser Benutzer ist bereits eingeloggt.");
    }
    loggedInUsers.add(username);
    res.redirect('/lobby');
  } else {
    res.send("Ungültige Zugangsdaten.");
  }
});

// Socket-Event: Liefert die Elo des angefragten Nutzers
io.on('connection', socket => {
  socket.on('getMyElo', (data) => {
    const userElo = accounts[data.username] ? accounts[data.username].elo : 1000;
    socket.emit('myElo', { elo: userElo });
  });
});

// --- Socket.IO-Events ---
io.on('connection', socket => {
  console.log('Ein Nutzer verbunden:', socket.id);
  socket.emit('lobbyList', lobbies);
  
  socket.on('getLobbyList', () => {
    socket.emit('lobbyList', lobbies);
    emitLobbyList();
  });
  
  socket.on('createLobby', (data) => {
    const lobby = {
      id: Date.now().toString(),
      host: data.username,
      players: [data.username],
      maxPlayers: 8,
      started: false,
      game: null,
      name: data.lobbyName || ("Lobby " + Date.now())
    };
    lobbies.push(lobby);
    socket.join(lobby.id);
    emitLobbyList();
  });
  
  socket.on('joinLobby', (data) => {
    const alreadyInLobby = lobbies.some(lobby => lobby.players.includes(data.username));
    if (alreadyInLobby) {
      socket.emit('errorMessage', 'Du bist bereits in einer Lobby.');
      return;
    }
    const lobby = lobbies.find(l => l.id === data.lobbyId);
    if (lobby) {
      if (lobby.host === data.username) {
        socket.emit('errorMessage', 'Du kannst deiner eigenen Lobby nicht beitreten.');
        return;
      }
      if (lobby.players.length < lobby.maxPlayers && !lobby.started) {
        lobby.players.push(data.username);
        socket.join(lobby.id);
        emitLobbyList();
      }
    }
  });
  
  socket.on('leaveLobby', (data) => {
    const lobby = lobbies.find(l => l.id === data.lobbyId);
    if (lobby) {
      const index = lobby.players.indexOf(data.username);
      if (index > -1) {
        lobby.players.splice(index, 1);
        socket.leave(lobby.id);
        if (lobby.players.length === 0 || lobby.host === data.username) {
          lobbies = lobbies.filter(l => l.id !== lobby.id);
        }
        emitLobbyList();
      } else {
        socket.emit('errorMessage', 'Du bist nicht in dieser Lobby.');
      }
    } else {
      socket.emit('errorMessage', 'Lobby nicht gefunden.');
    }
  });
  
  // Startet eine Runde nur für die aktuell in der Lobby befindlichen Spieler.
  // Nach Spielende wird die Lobby geschlossen.
  socket.on('startRound', (data) => {
    const lobby = lobbies.find(l => l.id === data.lobbyId);
    if (lobby && lobby.host === data.username && !lobby.started) {
      lobby.started = true;
      lobby.game = initializeGame(lobby.players);
      io.to(lobby.id).emit('gameStarted', lobby);
      io.to(lobby.id).emit('gameState', lobby.game);
      emitLobbyList();
    }
  });
  
  socket.on('joinGame', (data) => {
    const lobby = lobbies.find(l => l.id === data.lobbyId);
    if (lobby) {
      if (lobby.game && lobby.players.includes(data.username)) {
        socket.join(lobby.id);
        socket.emit('gameState', lobby.game);
      } else {
        socket.emit('errorMessage', 'Spiel wurde noch nicht gestartet.');
      }
    } else {
      socket.emit('errorMessage', 'Lobby oder Spiel nicht gefunden.');
    }
  });
  
  socket.on('playCard', (data) => {
    const lobby = lobbies.find(l => l.id === data.lobbyId);
    if (!lobby || !lobby.game) return;
    const game = lobby.game;
    game.lastInteraction = Date.now();
    if (game.turnOrder[game.currentTurnIndex] !== data.username) {
      socket.emit('errorMessage', 'Nicht dein Zug.');
      return;
    }
    const playerHand = game.hands[data.username];
    const cardIndex = playerHand.findIndex(c => c.rank === data.card.rank && c.suit === data.card.suit);
    if (cardIndex === -1) {
      socket.emit('errorMessage', 'Du hast diese Karte nicht.');
      return;
    }
    const topCard = game.discardPile[game.discardPile.length - 1];
    let valid = false;
    if (game.activeSuit) {
      if (data.card.suit === game.activeSuit || data.card.rank === "Unter") {
        valid = true;
      }
    } else {
      if (data.card.suit === topCard.suit || data.card.rank === topCard.rank || data.card.rank === "Unter") {
        valid = true;
      }
    }
    if (!valid) {
      socket.emit('errorMessage', 'Ungültiger Zug.');
      return;
    }
    if (game.penaltyCount > 0) {
      if (data.card.rank === "7") {
        game.penaltyCount += 2;
        game.drawnAfterPenalty[data.username] = false;
      } else {
        if (!game.drawnAfterPenalty[data.username]) {
          socket.emit('errorMessage', 'Bei Strafpunkten musst du zuerst Karten ziehen oder eine 7 spielen.');
          return;
        }
        game.penaltyCount = 0;
        game.drawnAfterPenalty[data.username] = false;
      }
    } else {
      if (data.card.rank === "7") {
        game.penaltyCount = 2;
      }
    }
	if(game.penaltyCount === 0){
		//game.drawnAfterPenalty = false;
		game.drawnAfterPenalty[data.username] = false;
	}
    const playedCard = playerHand.splice(cardIndex, 1)[0];
    game.discardPile.push(playedCard);
    game.activeSuit = null;
    if (playedCard.rank === "8") {
      game.skipNext = true;
    }
    if (playedCard.rank === "Unter") {
      if (data.chosenSuit && ["Kreuz", "Pik", "Herz", "Karo"].includes(data.chosenSuit)) {
        game.activeSuit = data.chosenSuit;
      } else {
        socket.emit('errorMessage', 'Ungültige Farbwahl.');
        playerHand.push(playedCard);
        game.discardPile.pop();
        return;
      }
    }
    if (playerHand.length === 0) {
      // Elo nur anpassen, wenn mehr als ein Spieler in der Lobby sind.
      if (lobby.players.length > 1) {
        game.turnOrder.forEach(player => {
          if (player === data.username) {
            accounts[player].elo = (accounts[player].elo || 1000) + 5;
          } else {
            accounts[player].elo = (accounts[player].elo || 1000) - 2;
          }
        });
      }
      saveAccounts();
      io.to(lobby.id).emit('gameEnded', { winner: data.username });
      // Schließe die Lobby, wenn ein Gewinner feststeht.
      lobbies = lobbies.filter(l => l.id !== data.lobbyId);
      emitLobbyList();
      return;
    }
    if (game.skipNext) {
      game.currentTurnIndex = (game.currentTurnIndex + 2) % game.turnOrder.length;
      game.skipNext = false;
    } else {
      game.currentTurnIndex = (game.currentTurnIndex + 1) % game.turnOrder.length;
    }
    io.to(lobby.id).emit('gameState', game);
  });
  
  socket.on('drawCard', (data) => {
    const lobby = lobbies.find(l => l.id === data.lobbyId);
    if (!lobby || !lobby.game) return;
    const game = lobby.game;
    game.lastInteraction = Date.now();
    if (game.turnOrder[game.currentTurnIndex] !== data.username) {
      socket.emit('errorMessage', 'Nicht dein Zug.');
      return;
    }
    const playerHand = game.hands[data.username];
    let drawCount;
    if (game.penaltyCount > 0) {
      drawCount = game.penaltyCount;
      game.penaltyCount = 0;
      game.drawnAfterPenalty[data.username] = false;
    } else {
      drawCount = 1;
      game.drawnAfterPenalty[data.username] = true;
    }
    for (let i = 0; i < drawCount; i++) {
      if (game.deck.length === 0) {
        let top = game.discardPile.pop();
        game.deck = game.discardPile;
        game.discardPile = [top];
        shuffle(game.deck);
      }
      const drawnCard = game.deck.pop();
      playerHand.push(drawnCard);
    }
    io.to(lobby.id).emit('gameState', game);
  });
  
  socket.on('endTurn', (data) => {
    const lobby = lobbies.find(l => l.id === data.lobbyId);
    if (!lobby || !lobby.game) return;
    const game = lobby.game;
    game.lastInteraction = Date.now();
    if (game.turnOrder[game.currentTurnIndex] !== data.username) {
      socket.emit('errorMessage', 'Nicht dein Zug.');
      return;
    }
    game.penaltyCount = 0;
    game.drawnAfterPenalty[data.username] = false;
    if (game.skipNext) {
      game.currentTurnIndex = (game.currentTurnIndex + 2) % game.turnOrder.length;
      game.skipNext = false;
    } else {
      game.currentTurnIndex = (game.currentTurnIndex + 1) % game.turnOrder.length;
    }
    io.to(lobby.id).emit('gameState', game);
  });
  
  socket.on('disconnect', () => {
    console.log('Ein Nutzer hat die Verbindung getrennt:', socket.id);
  });
});

// Inaktivitätsprüfung: Alle 60 Sekunden (5 Minuten Inaktivität)
// Schließt die Lobby komplett, wenn zu lange Inaktivität besteht.
setInterval(() => {
  const now = Date.now();
  lobbies = lobbies.filter(lobby => {
    if (lobby.started && lobby.game) {
      if (now - lobby.game.lastInteraction > 300000) {
        io.to(lobby.id).emit('gameEnded', { winner: null, reason: 'Lobby geschlossen wegen Inaktivität' });
        return false; // Lobby entfernen
      }
    }
    return true;
  });
  emitLobbyList();
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MauMau.fun Server läuft auf Port ${PORT}`);
});
