const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// Create WebSocket server without path restriction
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: '*', // Allow all origins for now - you can restrict this later
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Handle upgrade requests
server.on('upgrade', (request, socket, head) => {
  try {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch (err) {
    console.error('Upgrade error:', err);
    socket.destroy();
  }
});

// MongoDB Connection - moved up to ensure schemas are defined before use
const MONGODB_URI = 'mongodb+srv://Nexora:7Ib1bRpd3RtXe0nV@galaxycluster01.8pz68zq.mongodb.net/NexoraAI?retryWrites=true&w=majority&appName=Galaxycluster01';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000
})
.then(() => {
  console.log('Connected to MongoDB');
  // Verify database connection by checking collections  
  mongoose.connection.db.listCollections().toArray()
    .then(collections => {
      if (collections.length === 0) {
        console.log('No collections found. Database is empty.');
      } else {
        console.log('Available collections:', collections.map(c => c.name));
      }
    })
    .catch(err => console.error('Error listing collections:', err));
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1); // Exit if cannot connect to database
});

// Add connection error handler
mongoose.connection.on('error', err => {
  console.error('MongoDB connection error:', err);
});

// Add disconnection handler
mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected');
});

// User Schema with timestamps
const userSchema = new mongoose.Schema({
  email: { 
    type: String, 
    required: true, 
    unique: true,
    trim: true,
    lowercase: true
  },
  chats: [{
    role: { type: String, required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
  }],
  feedback: [{
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection from:', req.socket.remoteAddress);
  ws.isAlive = true;

  // Send initial connection success message
  ws.send(JSON.stringify({
    type: 'connection_status',
    status: 'connected'
  }));

  // Set up a ping interval to keep connection alive
  const pingInterval = setInterval(() => {
    if (!ws.isAlive) {
      console.log('Terminating inactive connection');
      clearInterval(pingInterval);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received WebSocket message:', data); // Add logging
      
      // Handle different types of messages
      if (data.type === 'chat') {
        // Store chat message in MongoDB
        const user = await User.findById(data.userId);
        if (user) {
          user.chats.push({
            role: data.role,
            content: data.content,
            timestamp: new Date()
          });
          await user.save();
          
          // Send acknowledgment back to client
          ws.send(JSON.stringify({
            type: 'chat_saved',
            success: true,
            messageId: user.chats[user.chats.length - 1]._id
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'User not found'
          }));
        }
      } else if (data.type === 'get_chat_history') {
        // Handle chat history request via WebSocket
        try {
          const user = await User.findById(data.userId);
          if (user) {
            ws.send(JSON.stringify({
              type: 'chat_history',
              success: true,
              chats: user.chats
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'User not found'
            }));
          }
        } catch (error) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Error fetching chat history: ' + error.message
          }));
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Error processing message: ' + error.message
      }));
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clearInterval(pingInterval);
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clearInterval(pingInterval);
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// Implement WebSocket server heartbeat
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating inactive connection');
      return ws.terminate();
    }
    ws.isAlive = false;
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// Add user validation middleware
const validateUser = async (req, res, next) => {
  try {
    const userId = req.params.userId;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ 
        error: 'Invalid user ID format',
        code: 'INVALID_USER_ID'
      });
    }
    
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ 
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }
    
    req.user = user;
    next();
  } catch (error) {
    console.error('User validation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// API Routes
app.post('/api/register', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    let user = await User.findOne({ email });
    
    if (user) {
      return res.json({ 
        userId: user._id,
        message: 'User already exists'
      });
    }
    
    user = new User({ email });
    await user.save();
    res.json({ 
      userId: user._id,
      message: 'User created successfully'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Modified chat endpoints to use the validation middleware
app.post('/api/chat/:userId', validateUser, async (req, res) => {
  try {
    const { role, content } = req.body;
    const user = req.user;

    if (!role || !content) {
      return res.status(400).json({ error: 'Role and content are required' });
    }

    const chatMessage = {
      role,
      content,
      timestamp: new Date()
    };

    user.chats.push(chatMessage);
    await user.save();

    res.json({ 
      success: true,
      messageId: user.chats[user.chats.length - 1]._id,
      timestamp: chatMessage.timestamp
    });
  } catch (error) {
    console.error('Error saving chat:', error);
    res.status(500).json({ error: 'Failed to save chat' });
  }
});

app.get('/api/chat/:userId', validateUser, async (req, res) => {
  try {
    const user = req.user;
    
    // Sort chats by timestamp to ensure proper order
    const sortedChats = user.chats.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    res.json({ 
      success: true, 
      chats: sortedChats,
      count: sortedChats.length
    });
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

// Clear chat history endpoint
app.delete('/api/chat/:userId', validateUser, async (req, res) => {
  try {
    const user = req.user;
    user.chats = [];
    await user.save();
    
    res.json({ 
      success: true,
      message: 'Chat history cleared'
    });
  } catch (error) {
    console.error('Error clearing chat history:', error);
    res.status(500).json({ error: 'Failed to clear chat history' });
  }
});

app.post('/api/feedback/:userId', validateUser, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const user = req.user;
    
    if (!rating || !comment) {
      return res.status(400).json({ error: 'Rating and comment are required' });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    
    const feedbackEntry = {
      rating,
      comment,
      timestamp: new Date()
    };

    user.feedback.push(feedbackEntry);
    await user.save();
    
    res.json({ 
      success: true,
      feedback: feedbackEntry
    });
  } catch (error) {
    console.error('Feedback error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/feedback/:userId', validateUser, async (req, res) => {
  try {
    const user = req.user;
    
    // Sort feedback by timestamp (newest first)
    const sortedFeedback = user.feedback.sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
    
    res.json({
      success: true,
      feedback: sortedFeedback,
      count: sortedFeedback.length
    });
  } catch (error) {
    console.error('Get feedback error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    timestamp: new Date(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// Serve main.html as the index page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

// Serve aura.html
app.get('/aura.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'aura.html'));
});

// Catch-all handler for unknown routes
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('Server and database connections closed.');
      process.exit(0);
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} for main page`);
  console.log(`Visit http://localhost:${PORT}/aura.html for aura page`);
});
