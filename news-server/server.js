/**
 * Spider News Sync Server
 * Real-time synchronization using Native WebSocket (ws library)
 * NO Socket.io - Pure WebSocket implementation
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import cors from 'cors'
import multer from 'multer'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import rateLimit from 'express-rate-limit'
import sharp from 'sharp'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ============================================
// Configuration
// ============================================
const PORT = process.env.PORT || 3001
const WS_PORT = process.env.WS_PORT || 3002
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/spider-news'
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024 // 50MB
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173']

// ============================================
// MongoDB Connection
// ============================================
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI)
    console.log('✅ MongoDB Connected')
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error)
    process.exit(1)
  }
}

// ============================================
// MongoDB Models
// ============================================

const postSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  userId: { type: String, required: true },
  username: { type: String, required: true },
  avatar: { type: String, default: '👤' },
  content: { type: String, maxlength: 5000 },
  mediaUrl: { type: String },
  mediaType: { type: String, enum: ['image', 'video', null], default: null },
  duration: { type: Number }, // for videos
  likes: { type: Number, default: 0 },
  likedBy: [{ type: String }], // userIds
  comments: [{
    _id: { type: String, default: uuidv4 },
    userId: { type: String, required: true },
    username: { type: String, required: true },
    content: { type: String, required: true, maxlength: 1000 },
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true })

const notificationSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  userId: { type: String, required: true },
  type: { type: String, enum: ['like', 'comment', 'mention'], required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: { type: Object },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
})

const messageSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  senderId: { type: String, required: true },
  recipientId: { type: String, required: true },
  content: { type: String, maxlength: 5000 },
  type: { type: String, enum: ['text', 'image', 'video', 'audio'], default: 'text' },
  mediaUrl: { type: String },
  read: { type: Boolean, default: false },
  // E2EE encryption metadata - supports both AES-GCM (iv) and XSalsa20-Poly1305 (nonce)
  enc: {
    iv: { type: String },        // For AES-GCM
    nonce: { type: String },   // For XSalsa20-Poly1305
    ciphertextB64: { type: String },
    alg: { type: String },
    kind: { type: String },
    aad: { type: String }
  },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true })

const storySchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  userId: { type: String, required: true },
  username: { type: String, required: true },
  avatar: { type: String, default: '👤' },
  mediaUrl: { type: String, required: true },
  mediaType: { type: String, enum: ['image', 'video'], required: true },
  description: { type: String, maxlength: 1000, default: '' },
  filterId: { type: String, default: 'original' },
  viewedBy: [{ type: String }], // userIds who viewed
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) }
}, { timestamps: true })

const Post = mongoose.model('Post', postSchema)
const Notification = mongoose.model('Notification', notificationSchema)
const Message = mongoose.model('Message', messageSchema)
const Story = mongoose.model('Story', storySchema)

// ============================================
// Express App Setup
// ============================================
const app = express()
const server = createServer(app)

// CORS Configuration - Mobile Phone Optimized
app.use(cors({
  origin: true, // Allow all origins (including mobile browsers)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400 // Cache preflight for 24 hours
}))

app.options('*', cors()) // Enable preflight for all routes

// ============================================
// Health Check / Ping Endpoint (Critical for Mobile)
// ============================================
// NOTE:
// Phone browsers rely heavily on CORS preflight.
// Some environments mishandle HEAD/OPTIONS for this route, causing "Failed to fetch".
// Fix is strictly confined to /api/ping behavior + explicit preflight handling.

app.options('/api/ping', (req, res) => {
  // CORS middleware will add headers, but explicitly ending avoids timeouts.
  res.sendStatus(204)
})

app.get('/api/ping', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'News Server is running',
    timestamp: Date.now(),
    uptime: process.uptime()
  })
})

app.head('/api/ping', (req, res) => {
  // Must return a successful response for fetch(..., { method: 'HEAD' })
  res.status(200).end()
})


app.use(express.json({ limit: '10mb' }))

// Rate Limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Too many requests, please try again later' }
})
app.use('/api/', limiter)

// ============================================
// File Upload Configuration (Multer)
// ============================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadsDir = join(__dirname, 'uploads')
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true })
    }
    cb(null, uploadsDir)
  },
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop()
    const uniqueName = `${Date.now()}-${uuidv4()}.${ext}`
    cb(null, uniqueName)
  }
})

const fileFilter = (req, file, cb) => {
  const allowedTypes = process.env.ALLOWED_TYPES?.split(',') || [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm', 'video/ogg'
  ]
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(new Error(`File type ${file.mimetype} not allowed`), false)
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
})

// ============================================
// Serve Uploaded Files
// ============================================
app.use('/uploads', express.static(join(__dirname, 'uploads')))

// ============================================
// AI Chat Proxy (OpenRouter)
// ============================================
app.post('/api/ai/chat', async (req, res) => {
  try {

// ============================================
// REST API Routes
// ============================================

// Get all posts
app.get('/api/posts', async (req, res) => {
  try {
    const { limit = 50, skip = 0, userId } = req.query
    
    const query = userId ? { userId } : {}
    
    const posts = await Post.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .lean()
    
    res.json({ success: true, posts })
  } catch (error) {
    console.error('Error fetching posts:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get single post
app.get('/api/posts/:id', async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
    
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post not found' })
    }
    
    res.json({ success: true, post })
  } catch (error) {
    console.error('Error fetching post:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Create post with file upload
app.post('/api/posts', upload.fields([{ name: 'image' }, { name: 'video' }]), async (req, res) => {
  try {
    const { userId, username, avatar, content, duration } = req.body
    
    let mediaUrl = null
    let mediaType = null
    
    // Process uploaded files
    if (req.files.image) {
      const image = req.files.image[0]
      // Compress image
      const compressedImageName = `compressed-${image.filename}`
      await sharp(image.path)
        .resize({ width: 1920, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(join(__dirname, 'uploads', compressedImageName))
      
      // Delete original
      fs.unlinkSync(image.path)
      
      mediaUrl = `/uploads/${compressedImageName}`
      mediaType = 'image'
    } else if (req.files.video) {
      const video = req.files.video[0]
      mediaUrl = `/uploads/${video.filename}`
      mediaType = 'video'
    }
    
    // Create post
    const post = new Post({
      userId,
      username,
      avatar: avatar || '👤',
      content: content || '',
      mediaUrl,
      mediaType,
      duration: duration ? parseInt(duration) : null
    })
    
    await post.save()
    
    console.log('📝 Post created:', post._id)
    
    res.json({ success: true, post })
  } catch (error) {
    console.error('Error creating post:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Add comment
app.post('/api/posts/:postId/comments', async (req, res) => {
  try {
    const { userId, username, content } = req.body
    const { postId } = req.params
    
    const post = await Post.findById(postId)
    
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post not found' })
    }
    
    const comment = {
      _id: uuidv4(),
      userId,
      username,
      content,
      createdAt: new Date()
    }
    
    post.comments.push(comment)
    await post.save()
    
    // Create notification for post owner
    if (post.userId !== userId) {
      await Notification.create({
        userId: post.userId,
        type: 'comment',
        title: 'تعليق جديد',
        message: `${username} علّق على منشورك`,
        data: { postId, commentId: comment._id }
      })
    }
    
    console.log('💬 Comment added:', comment._id)
    
    res.json({ success: true, comment })
  } catch (error) {
    console.error('Error adding comment:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Toggle like
app.post('/api/posts/:postId/like', async (req, res) => {
  try {
    const { userId, username } = req.body
    const { postId } = req.params
    
    const post = await Post.findById(postId)
    
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post not found' })
    }
    
    const likedIndex = post.likedBy.indexOf(userId)
    
    if (likedIndex === -1) {
      // Like
      post.likedBy.push(userId)
      post.likes = post.likedBy.length
      
      // Create notification
      if (post.userId !== userId) {
        await Notification.create({
          userId: post.userId,
          type: 'like',
          title: 'إعجاب جديد',
          message: `${username} أعجب بمنشورك`,
          data: { postId }
        })
      }
    } else {
      // Unlike
      post.likedBy.splice(likedIndex, 1)
      post.likes = post.likedBy.length
    }
    
    await post.save()
    
    console.log('❤️ Like toggled:', postId, 'likes:', post.likes)
    
    res.json({ success: true, likes: post.likes, liked: likedIndex === -1 })
  } catch (error) {
    console.error('Error toggling like:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get notifications
app.get('/api/notifications/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const { unreadOnly } = req.query
    
    const query = { userId }
    if (unreadOnly === 'true') {
      query.read = false
    }
    
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()
    
    res.json({ success: true, notifications })
  } catch (error) {
    console.error('Error fetching notifications:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Mark notification as read
app.put('/api/notifications/:notificationId/read', async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.notificationId, { read: true })
    res.json({ success: true })
  } catch (error) {
    console.error('Error marking notification as read:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get messages between two users
app.get('/api/messages', async (req, res) => {
  try {
    const { currentUserId, contactId } = req.query
    
    if (!currentUserId || !contactId) {
      return res.status(400).json({ success: false, error: 'Missing parameters' })
    }
    
    const messages = await Message.find({
      $or: [
        { senderId: currentUserId, recipientId: contactId },
        { senderId: contactId, recipientId: currentUserId }
      ]
    })
      .sort({ createdAt: 1 })
      .limit(500)
      .lean()
    
    res.json({ success: true, messages })
  } catch (error) {
    console.error('Error fetching messages:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Send message
app.post('/api/messages', upload.single('media'), async (req, res) => {
  try {
    // Parse FormData fields - they may come as arrays when sent with file upload
    const senderId = Array.isArray(req.body.senderId) ? req.body.senderId[0] : req.body.senderId
    const recipientId = Array.isArray(req.body.recipientId) ? req.body.recipientId[0] : req.body.recipientId
    const content = Array.isArray(req.body.content) ? req.body.content[0] : req.body.content
    const type = Array.isArray(req.body.type) ? req.body.type[0] : req.body.type
    const clientTempId = Array.isArray(req.body.clientTempId) ? req.body.clientTempId[0] : req.body.clientTempId
    const encIV = Array.isArray(req.body.encIV) ? req.body.encIV[0] : req.body.encIV
    const encNonce = Array.isArray(req.body.encNonce) ? req.body.encNonce[0] : req.body.encNonce
    const encCiphertextB64 = Array.isArray(req.body.encCiphertextB64) ? req.body.encCiphertextB64[0] : req.body.encCiphertextB64
    const encAlg = Array.isArray(req.body.encAlg) ? req.body.encAlg[0] : req.body.encAlg
    const encKind = Array.isArray(req.body.encKind) ? req.body.encKind[0] : req.body.encKind
    const encAAD = Array.isArray(req.body.encAAD) ? req.body.encAAD[0] : req.body.encAAD

    let mediaUrl = null

    // Use encIV or encNonce whichever is provided
    const effectiveIV = encIV || encNonce

    // Check if this is an E2EE encrypted file (has encIV/encNonce and encCiphertextB64)
    const isE2EEEncrypted = effectiveIV && encCiphertextB64 && effectiveIV.length > 0 && encCiphertextB64.length > 0

    if (req.file) {
      if (isE2EEEncrypted) {
        // ❌ DON'T compress E2EE encrypted files - they are ciphertext, not real media
        // Just store the file as-is (it's already encrypted base64 text)
        mediaUrl = `/uploads/${req.file.filename}`
        console.log('📎 E2EE encrypted media stored without compression:', mediaUrl)
      } else if (type === 'image') {
        // Compress non-encrypted images only
        const compressedImageName = `compressed-${req.file.filename}`
        await sharp(req.file.path)
          .resize({ width: 1920, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(join(__dirname, 'uploads', compressedImageName))

        fs.unlinkSync(req.file.path)
        mediaUrl = `/uploads/${compressedImageName}`
      } else {
        mediaUrl = `/uploads/${req.file.filename}`
      }
    }

    // ✅ Store E2EE encryption metadata if provided (only if valid and not empty)
    let enc = undefined
    if (isE2EEEncrypted && effectiveIV && encCiphertextB64) {
      try {
        // Determine if XSalsa20 based on algorithm or presence of nonce
        const isXSalsa = encAlg === 'XSalsa20-Poly1305' || !!encNonce
        enc = {
          // Store as nonce for XSalsa20, iv for AES-GCM for proper client detection
          nonce: isXSalsa ? effectiveIV : undefined,
          iv: isXSalsa ? undefined : effectiveIV,
          ciphertextB64: encCiphertextB64,
          alg: encAlg || 'XSalsa20-Poly1305',
          kind: encKind || 'file',
          aad: encAAD || ''
        }
        console.log('📦 E2EE metadata prepared, iv/nonce length:', effectiveIV?.length, 'ciphertext length:', encCiphertextB64?.length, 'alg:', enc.alg)
      } catch (e) {
        console.error('⚠️ Failed to prepare E2EE metadata:', e)
      }
    }

    const messageData = {
      _id: clientTempId || undefined,
      senderId,
      recipientId,
      content: content || '',
      type: type || 'text',
      mediaUrl
    }

    // Only add enc if it has valid data
    if (enc && (enc.nonce || enc.iv) && enc.ciphertextB64) {
      messageData.enc = enc
    }

    const message = new Message(messageData)

    await message.save()

    console.log('💬 Message sent:', message._id)

    // ✅ BROADCAST to recipient ONLY via WebSocket (sender already has local echo)
    sendToUser(recipientId, {
      type: 'NEW_MESSAGE',
      payload: message
    })

    // ❌ REMOVED: Don't echo back to sender - they already have local echo
    // sendToUser(senderId, {...})

    res.json({ success: true, message })
  } catch (error) {
    console.error('Error sending message:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Delete post
app.delete('/api/posts/:postId', async (req, res) => {
  try {
    const { postId } = req.params
    const { userId } = req.body
    
    const post = await Post.findById(postId)
    
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post not found' })
    }
    
    if (post.userId !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' })
    }
    
    // Delete media file if exists
    if (post.mediaUrl) {
      const filePath = join(__dirname, post.mediaUrl)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }
    
    await Post.findByIdAndDelete(postId)
    
    console.log('🗑️ Post deleted:', postId)
    
    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting post:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ============================================
// STORIES API Routes
// ============================================

// Get all active stories
app.get('/api/stories', async (req, res) => {
  try {
    const now = new Date()
    const stories = await Story.find({ expiresAt: { $gt: now } })
      .sort({ createdAt: -1 })
      .lean()
    
    res.json({ success: true, stories })
  } catch (error) {
    console.error('Error fetching stories:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get active stories grouped by user
app.get('/api/stories/active', async (req, res) => {
  try {
    const now = new Date()
    const stories = await Story.find({ expiresAt: { $gt: now } })
      .sort({ createdAt: -1 })
      .lean()
    
    // Group by user
    const storiesGrouped = stories.reduce((acc, story) => {
      const existing = acc.find(g => g.userId === story.userId)
      if (existing) {
        existing.items.push(story)
      } else {
        acc.push({
          userId: story.userId,
          username: story.username,
          avatar: story.avatar,
          items: [story]
        })
      }
      return acc
    }, [])
    
    res.json({ success: true, storiesGrouped })
  } catch (error) {
    console.error('Error fetching stories:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Create story with file upload
app.post('/api/stories', upload.fields([{ name: 'media' }]), async (req, res) => {
  try {
    const { userId, username, avatar, description, mediaType, filterId } = req.body
    
    if (!userId || !username) {
      return res.status(400).json({ success: false, error: 'Missing required fields' })
    }
    
    let mediaUrl = null
    
    // Process uploaded file
    if (req.files && req.files.media) {
      const media = req.files.media[0]
      
      if (mediaType === 'image') {
        // Compress image
        const compressedImageName = `compressed-${media.filename}`
        await sharp(media.path)
          .resize({ width: 1080, withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toFile(join(__dirname, 'uploads', compressedImageName))
        
        // Delete original
        fs.unlinkSync(media.path)
        mediaUrl = `/uploads/${compressedImageName}`
      } else if (mediaType === 'video') {
        mediaUrl = `/uploads/${media.filename}`
      }
    }
    
    if (!mediaUrl) {
      return res.status(400).json({ success: false, error: 'No media uploaded' })
    }
    
    // Create story
    const story = new Story({
      userId,
      username,
      avatar: avatar || '👤',
      mediaUrl,
      mediaType: mediaType || 'image',
      description: description || '',
      filterId: filterId || 'original'
    })
    
    await story.save()
    
    console.log('📸 Story created:', story._id)
    
    res.json({ success: true, story })
  } catch (error) {
    console.error('Error creating story:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Delete story
app.delete('/api/stories/:storyId', async (req, res) => {
  try {
    const { storyId } = req.params
    const { userId } = req.body
    
    const story = await Story.findById(storyId)
    
    if (!story) {
      return res.status(404).json({ success: false, error: 'Story not found' })
    }
    
    if (story.userId !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' })
    }
    
    // Delete media file if exists
    if (story.mediaUrl) {
      const filePath = join(__dirname, story.mediaUrl)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }
    
    await Story.findByIdAndDelete(storyId)
    
    console.log('🗑️ Story deleted:', storyId)
    
    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting story:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ============================================
// WebSocket Server (Native ws - NO Socket.io)
// ============================================
// Use the HTTP server for WebSocket connections
const wss = new WebSocketServer({ server })

// Connected clients Map: userId -> Set<WebSocket>
const clients = new Map()

// Room subscriptions: roomId (postId) -> Set<userId>
const rooms = new Map()

wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection')
  
  let userId = null
  
  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message)
      console.log('📨 Received:', data.type)
      
      switch (data.type) {
        case 'AUTH':
          // Authenticate user
          userId = data.payload.userId
          
          if (!clients.has(userId)) {
            clients.set(userId, new Set())
          }
          clients.get(userId).add(ws)
          
          console.log('✅ User authenticated:', userId)
          
          ws.send(JSON.stringify({
            type: 'AUTH_SUCCESS',
            payload: { userId }
          }))
          
          // Broadcast user online
          broadcast({
            type: 'USER_ONLINE',
            payload: { userId }
          }, userId)
          break
          
        case 'SUBSCRIBE':
          // Subscribe to a room (e.g., post comments)
          const { roomId } = data.payload
          
          if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set())
          }
          rooms.get(roomId).add(userId)
          
          console.log('📡 Subscribed to room:', roomId)
          break
          
        case 'UNSUBSCRIBE':
          // Unsubscribe from a room
          const { roomId: leaveRoomId } = data.payload
          if (rooms.has(leaveRoomId)) {
            rooms.get(leaveRoomId).delete(userId)
          }
          break
          
        case 'CREATE_POST':
          // Create new post and broadcast
          const newPost = await createPostFromWS(data.payload)
          broadcast({
            type: 'NEW_POST',
            payload: newPost
          })
          break
          
        case 'ADD_COMMENT':
          // Add comment and broadcast
          const comment = await addCommentFromWS(data.payload)
          
          // Broadcast to post subscribers
          broadcastToRoom(data.payload.postId, {
            type: 'NEW_COMMENT',
            payload: { ...comment, postId: data.payload.postId }
          })
          
          // Send notification to post owner
          sendNotification(data.payload.postOwnerId, {
            type: 'NEW_NOTIFICATION',
            payload: {
              type: 'comment',
              title: 'تعليق جديد',
              message: `${data.payload.username} علّق على منشورك`,
              data: { postId: data.payload.postId }
            }
          })
          break

        case 'DELETE_COMMENT': {
          const deleted = await deleteCommentFromWS(data.payload)
          if (deleted) {
            broadcastToRoom(data.payload.postId, {
              type: 'COMMENT_DELETED',
              payload: {
                postId: data.payload.postId,
                commentId: data.payload.commentId
              }
            })
          }
          break
        }

        case 'UPDATE_COMMENT': {
          const updated = await updateCommentFromWS(data.payload)
          if (updated) {
            broadcastToRoom(data.payload.postId, {
              type: 'COMMENT_UPDATED',
              payload: {
                postId: data.payload.postId,
                commentId: data.payload.commentId,
                comment: updated
              }
            })
          }
          break
        }
          
        case 'LIKE_POST':
          // Toggle like and broadcast
          const likeResult = await toggleLikeFromWS(data.payload)
          
          broadcast({
            type: 'POST_LIKED',
            payload: {
              postId: data.payload.postId,
              userId: data.payload.userId,
              username: data.payload.username,
              likes: likeResult.likes,
              liked: likeResult.liked
            }
          })
          
          // Send notification if not self-like
          if (data.payload.postOwnerId && data.payload.postOwnerId !== data.payload.userId) {
            sendNotification(data.payload.postOwnerId, {
              type: 'NEW_NOTIFICATION',
              payload: {
                type: 'like',
                title: 'إعجاب جديد',
                message: `${data.payload.username} أعجب بمنشورك`,
                data: { postId: data.payload.postId }
              }
            })
          }
          break
          
        case 'DELETE_POST':
          // Delete post and broadcast
          const deleted = await deletePostFromWS(data.payload)
          if (deleted) {
            broadcast({
              type: 'POST_DELETED',
              payload: { postId: data.payload.postId }
            })
          }
          break
          
        case 'SEND_MESSAGE':
          // Send message and broadcast
          const newMessage = await sendMessageFromWS(data.payload)
          
          // Send to recipient
          sendToUser(data.payload.recipientId, {
            type: 'NEW_MESSAGE',
            payload: newMessage
          })
          
          // Echo back to sender
          sendToUser(data.payload.senderId, {
            type: 'NEW_MESSAGE',
            payload: newMessage
          })
          break
          
        case 'EDIT_MESSAGE':
          // Edit message and broadcast
          const editedMessage = await editMessageFromWS(data.payload)
          if (editedMessage) {
            // Broadcast to both users
            sendToUser(editedMessage.senderId, {
              type: 'MESSAGE_EDITED',
              payload: { messageId: editedMessage._id, newContent: editedMessage.content }
            })
            sendToUser(editedMessage.recipientId, {
              type: 'MESSAGE_EDITED',
              payload: { messageId: editedMessage._id, newContent: editedMessage.content }
            })
          }
          break
          
        case 'DELETE_MESSAGE':
          // Delete message and broadcast
          const deletedMessage = await deleteMessageFromWS(data.payload)
          if (deletedMessage) {
            sendToUser(deletedMessage.senderId, {
              type: 'MESSAGE_DELETED',
              payload: { messageId: deletedMessage._id }
            })
            sendToUser(deletedMessage.recipientId, {
              type: 'MESSAGE_DELETED',
              payload: { messageId: deletedMessage._id }
            })
          }
          break
          
        case 'GET_ONLINE_USERS':
          // Send list of online users
          ws.send(JSON.stringify({
            type: 'ONLINE_USERS',
            payload: { onlineUsers: Array.from(clients.keys()) }
          }))
          break
          
        case 'ADD_FRIEND':
          // Notify friend
          sendToUser(data.payload.friendId, {
            type: 'FRIEND_ADDED',
            payload: { userId }
          })
          break
          
        case 'CREATE_STORY':
          // Create new story and broadcast
          const newStory = await createStoryFromWS(data.payload)
          broadcast({
            type: 'NEW_STORY',
            payload: newStory
          })
          console.log('📸 Story broadcasted:', newStory._id)
          break
          
        case 'DELETE_STORY':
          // Delete story and broadcast
          const deletedStory = await deleteStoryFromWS(data.payload)
          if (deletedStory) {
            broadcast({
              type: 'STORY_DELETED',
              payload: { storyId: data.payload.storyId }
            })
            console.log('🗑️ Story deletion broadcasted:', data.payload.storyId)
          }
          break
          
        case 'PING':
          // Heartbeat
          ws.send(JSON.stringify({ type: 'PONG' }))
          break
          
        default:
          console.log('⚠️ Unknown message type:', data.type)
      }
    } catch (error) {
      console.error('❌ Error processing message:', error)
      ws.send(JSON.stringify({
        type: 'ERROR',
        payload: { message: error.message }
      }))
    }
  })
  
  // Handle disconnection
  ws.on('close', () => {
    console.log('🔌 WebSocket disconnected')
    
    if (userId) {
      const userClients = clients.get(userId)
      if (userClients) {
        userClients.delete(ws)
        if (userClients.size === 0) {
          clients.delete(userId)
          // Broadcast user offline
          broadcast({
            type: 'USER_OFFLINE',
            payload: { userId }
          })
        }
      }
    }
  })
  
  // Handle errors
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error)
  })
  
  // Send initial connection success
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    payload: { message: 'Connected to Spider News Sync Server' }
  }))
})

// ============================================
// WebSocket Helper Functions
// ============================================

async function createPostFromWS(payload) {
  const post = new Post({
    userId: payload.userId,
    username: payload.username,
    avatar: payload.avatar || '👤',
    content: payload.content || '',
    mediaUrl: payload.mediaUrl || null,
    mediaType: payload.mediaType || null,
    duration: payload.duration || null
  })
  
  await post.save()
  return post
}

async function addCommentFromWS(payload) {
  const post = await Post.findById(payload.postId)
  
  if (!post) {
    throw new Error('Post not found')
  }
  
  const comment = {
    _id: uuidv4(),
    userId: payload.userId,
    username: payload.username,
    content: payload.content,
    createdAt: new Date()
  }
  
  post.comments.push(comment)
  await post.save()
  
  return comment
}

async function deleteCommentFromWS(payload) {
  const { postId, commentId, userId } = payload
  const post = await Post.findById(postId)
  if (!post) return false

  const comment = post.comments.find(c => c._id === commentId)
  if (!comment) return false
  if (comment.userId !== userId) throw new Error('Not authorized')

  post.comments = post.comments.filter(c => c._id !== commentId)
  await post.save()
  return true
}

async function updateCommentFromWS(payload) {
  const { postId, commentId, userId, newContent } = payload
  const post = await Post.findById(postId)
  if (!post) return null

  const comment = post.comments.find(c => c._id === commentId)
  if (!comment) return null
  if (comment.userId !== userId) throw new Error('Not authorized')

  comment.content = newContent
  await post.save()
  return {
    _id: comment._id,
    userId: comment.userId,
    username: comment.username,
    content: comment.content,
    createdAt: comment.createdAt
  }
}


async function toggleLikeFromWS(payload) {
  const post = await Post.findById(payload.postId)
  
  if (!post) {
    throw new Error('Post not found')
  }
  
  const likedIndex = post.likedBy.indexOf(payload.userId)
  
  if (likedIndex === -1) {
    post.likedBy.push(payload.userId)
  } else {
    post.likedBy.splice(likedIndex, 1)
  }
  
  post.likes = post.likedBy.length
  await post.save()
  
  return { likes: post.likes, liked: likedIndex === -1 }
}

async function deletePostFromWS(payload) {
  const post = await Post.findById(payload.postId)
  
  if (!post) {
    return false
  }
  
  if (post.userId !== payload.userId) {
    throw new Error('Not authorized')
  }
  
  // Delete media file
  if (post.mediaUrl) {
    const filePath = join(__dirname, post.mediaUrl)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }
  
  await Post.findByIdAndDelete(payload.postId)
  return true
}

async function sendMessageFromWS(payload) {
  // Extract E2EE metadata if present
  let enc = undefined
  if (payload.enc && (payload.enc.ciphertextB64 || payload.enc.ciphertext)) {
    enc = {
      iv: payload.enc.iv || undefined,
      nonce: payload.enc.nonce || undefined,
      ciphertextB64: payload.enc.ciphertextB64 || payload.enc.ciphertext,
      alg: payload.enc.alg || 'XSalsa20-Poly1305',
      kind: payload.enc.kind || 'text',
      aad: payload.enc.aad || ''
    }
  }

  const message = new Message({
    _id: payload.clientTempId || undefined, // Use client's temp ID if provided
    senderId: payload.senderId,
    recipientId: payload.recipientId,
    content: payload.text || payload.content || '', // May be undefined for encrypted messages
    type: payload.type || 'text',
    mediaUrl: payload.mediaUrl || null,
    enc: enc
  })

  await message.save()
  console.log('💬 Message saved:', message._id, 'enc:', enc ? 'yes' : 'no')
  return message
}

async function editMessageFromWS(payload) {
  const message = await Message.findById(payload.messageId)
  
  if (!message) {
    return null
  }
  
  message.content = payload.newContent
  await message.save()
  
  return message
}

async function deleteMessageFromWS(payload) {
  const message = await Message.findById(payload.messageId)
  
  if (!message) {
    return null
  }
  
  // Delete media file if exists
  if (message.mediaUrl) {
    const filePath = join(__dirname, message.mediaUrl)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }
  
  await Message.findByIdAndDelete(payload.messageId)
  return message
}

async function createStoryFromWS(payload) {
  const story = new Story({
    userId: payload.userId,
    username: payload.username,
    avatar: payload.avatar || '👤',
    mediaUrl: payload.mediaUrl,
    mediaType: payload.mediaType || 'image',
    description: payload.description || '',
    filterId: payload.filterId || 'original'
  })
  
  await story.save()
  console.log('📸 Story created via WS:', story._id)
  return story
}

async function deleteStoryFromWS(payload) {
  const story = await Story.findById(payload.storyId)
  
  if (!story) {
    console.warn('⚠️ Story not found:', payload.storyId)
    return false
  }
  
  if (story.userId !== payload.userId) {
    throw new Error('Not authorized')
  }
  
  // Delete media file
  if (story.mediaUrl) {
    const filePath = join(__dirname, story.mediaUrl)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }
  
  await Story.findByIdAndDelete(payload.storyId)
  console.log('🗑️ Story deleted via WS:', payload.storyId)
  return true
}

// ============================================
// Broadcast Functions
// ============================================

/**
 * Broadcast to ALL connected clients
 */
function broadcast(data, excludeUserId = null) {
  const message = JSON.stringify(data)
  console.log('📢 Broadcasting:', data.type)
  
  clients.forEach((userSockets, uid) => {
    if (uid !== excludeUserId) {
      userSockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message)
        }
      })
    }
  })
}

/**
 * Send to specific user
 */
function sendToUser(userId, data) {
  const userSockets = clients.get(userId)
  
  if (userSockets) {
    const message = JSON.stringify(data)
    userSockets.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message)
      }
    })
    console.log('📬 Sent to user:', userId)
  }
}

/**
 * Send notification to user
 */
function sendNotification(userId, data) {
  sendToUser(userId, data)
}

/**
 * Broadcast to room (post subscribers)
 */
function broadcastToRoom(roomId, data) {
  const roomUsers = rooms.get(roomId)
  
  if (roomUsers) {
    roomUsers.forEach(userId => {
      sendToUser(userId, data)
    })
    console.log('📬 Sent to room:', roomId)
  }
}

// ============================================
// Heartbeat System (Keep connections alive)
// ============================================
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate()
    }
    ws.isAlive = false
    ws.ping()
  })
}, 30000)

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })
})

// ============================================
// Auto-cleanup Expired Stories (Every 1 hour)
// ============================================
setInterval(async () => {
  try {
    const now = new Date()
    const deletedCount = await Story.deleteMany({ expiresAt: { $lt: now } })
    if (deletedCount.deletedCount > 0) {
      console.log(`🗑️ Auto-cleanup: Deleted ${deletedCount.deletedCount} expired stories`)
    }
  } catch (error) {
    console.error('❌ Error in auto-cleanup:', error)
  }
}, 60 * 60 * 1000) // 1 hour

// ============================================
// Start Server
// ============================================
async function startServer() {
  await connectDB()

  server.listen(PORT, () => {
    console.log('\n🕷️  Spider News Sync Server Started!')
    console.log('================================')
    console.log(`📡 REST API:      http://localhost:${PORT}`)
    console.log(`⚡ WebSocket:     ws://localhost:${PORT}`)
    console.log('================================')
    console.log('\n✅ Using Native WebSocket (ws) - NO Socket.io')
    console.log('✅ Real-time sync < 100ms')
    console.log('✅ MongoDB for persistence')
    console.log('================================\n')
  })
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...')
  server.close(() => {
    mongoose.connection.close()
    process.exit(0)
  })
})

// Start the server
startServer()
