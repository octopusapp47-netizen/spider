/**
 * Spider Sync Server
 * خادم المزامنة الفورية للمنصّة الاجتماعية
 *
 * In-memory storage (no native dependencies needed)
 * - WebSocket for real-time sync
 * - HTTP API as fallback
 * - File uploads support
 * - 🤖 OpenRouter AI Proxy (آمن)
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

// قراءة ملف .env (المفتاح السري يبقى على الخادم فقط)
try {
  const dotenv = require('dotenv')
  dotenv.config()
  console.log('✅ .env loaded')
} catch {
  // dotenv اختياري — يمكن تعيين المتغيرات يدوياً
  console.log('ℹ️ dotenv not found, using system environment variables')
}

import process from 'process'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import cors from 'cors'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'

// ─── OpenRouter نستخدم fetch المدمج في Node.js 18+ ───
// يعمل بشكل أفضل من @openrouter/sdk

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)


// ============================================
// Configuration
// ============================================
const PORT = process.env.PORT || 3001

// ============================================
// In-Memory Database
// ============================================
let posts = []
let comments = []
let notifications = []
let postLikes = []
let stories = []
let users = {} // إضافة تخزين المستخدمين في الذاكرة

// ===== Online Users Tracking =====
let onlineUsers = new Map() // ws -> {userId, username, avatar, joinedAt}

// ===== Group Chat Storage =====
let groups = [] // { id, name, creatorId, members: [{userId, username, avatar, role}], createdAt }
let groupMessages = {} // { groupId: [messages] }

// ===== Direct Messages Storage =====
let directMessages = [] // { id, senderId, recipientId, content, type, mediaUrl, enc, timestamp }

function getDirectMessages(userId1, userId2) {
  return directMessages.filter(m =>
    (m.senderId === userId1 && m.recipientId === userId2) ||
    (m.senderId === userId2 && m.recipientId === userId1)
  ).sort((a, b) => a.timestamp - b.timestamp)
}

// Story Controller functions (simplified for in-memory)
// In a real app, these would be in a separate controller file
// and interact with a database.
const handleCreateStory = (req, res) => {
  try {
    const { userId, username, avatar, mediaType, description, filterId } = req.body
    
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No media file uploaded.' })
    }

    const story = {
      _id: uuidv4(), // Changed to _id to match client-side expectation
      userId: userId || '1',
      username: username || 'مستخدم',
      avatar: avatar || '👤',
      mediaUrl: `/uploads/${req.file.filename}`,
      mediaType: mediaType || (req.file.mimetype.startsWith('image/') ? 'image' : 'video'),
      description: description || '',
      filterId: filterId || 'original',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // تنتهي بعد 24 ساعة
      views: []
    }

    stories.unshift(story)
    console.log('📸 New story created:', story._id, '| media:', story.mediaType)

    broadcastWS({
      type: 'NEW_STORY',
      payload: story
    })

    res.status(201).json({ success: true, story })
  } catch (error) {
    console.error('❌ Error creating story:', error)
    res.status(500).json({ success: false, error: error.message })
  }
}

const handleGetActiveStories = (req, res) => {
  try {
    const now = new Date()
    const activeStories = stories.filter(story => new Date(story.expiresAt) > now)
    
    // Group stories by userId
    const groupedStories = activeStories.reduce((acc, story) => {
      if (!acc[story.userId]) {
        acc[story.userId] = {
          userId: story.userId,
          username: story.username || 'مستخدم',
          avatar: story.avatar || '👤',
          items: []
        }
      }
      acc[story.userId].items.push(story)
      return acc
    }, {})

    res.json({ success: true, storiesGrouped: Object.values(groupedStories) })
  } catch (error) {
    console.error('❌ Error fetching active stories:', error)
    res.status(500).json({ success: false, error: error.message })
  }
}

const handleDeleteStory = (req, res) => {
  try {
    const { storyId } = req.params
    const { userId } = req.body // Assuming userId is sent for authorization

    const index = stories.findIndex(s => s._id === storyId && s.userId === userId)
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Story not found or unauthorized' })
    }

    stories.splice(index, 1)
    console.log('🗑️ Story deleted:', storyId)

    broadcastWS({
      type: 'STORY_DELETED',
      payload: { storyId }
    })

    res.json({ success: true })
  } catch (error) {
    console.error('❌ Error deleting story:', error)
    res.status(500).json({ success: false, error: error.message })
  }
}

// ============================================
// Express App (HTTP API)
// ============================================
const app = express()

// ============================================
// CORS Configuration - Mobile Phone Optimized
// ============================================
app.use(cors({
  origin: true, // Allow all origins (including mobile browsers)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  maxAge: 86400 // Cache preflight for 24 hours
}))

app.options('*', cors()) // Enable preflight for all routes

app.use(express.json({ limit: '50mb' }))

// ============================================
// Rate Limiting (Simple in-memory)
// ============================================
const rateLimitMap = new Map()
const RATE_LIMIT_MAX = 999999 // max requests per minute (practically unlimited)
const RATE_LIMIT_WINDOW = 60000 // per minute

function rateLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const windowStart = now - RATE_LIMIT_WINDOW

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now })
    return next()
  }

  const clientData = rateLimitMap.get(ip)

  // Reset if window expired
  if (clientData.firstRequest < windowStart) {
    clientData.count = 1
    clientData.firstRequest = now
    return next()
  }

  // Increment count
  clientData.count++

  if (clientData.count > RATE_LIMIT_MAX) {
    console.warn(`⚠️ Rate limit exceeded for IP: ${ip}`)
    return res.status(429).json({
      success: false,
      error: 'Too Many Requests - Please wait a moment and try again',
      retryAfter: Math.ceil((clientData.firstRequest + RATE_LIMIT_WINDOW - now) / 1000)
    })
  }

  next()
}

// ============================================
// Health Check / Ping Endpoint (Critical for Mobile)
// ============================================
app.get('/api/ping', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
    timestamp: Date.now(),
    uptime: process.uptime()
  })
})

app.head('/api/ping', (req, res) => {
  res.status(200).end()
})

// Rate limiter applied AFTER ping endpoint
app.use(rateLimiter)

app.head('/api/ping', (req, res) => {
  res.status(200).end()
})

// File upload setup
const uploadsDir = join(__dirname, 'uploads')
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir)
  },
  filename: (req, file, cb) => {
    // حفظ الملف بإسم آمن مع امتداد صحيح
    const ext = file.originalname.split('.').pop()
    const uniqueName = `${Date.now()}-${uuidv4()}.${ext}`
    cb(null, uniqueName)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
})

// ============================================
// HTTP API Routes
// ============================================

// GET /api/posts - جلب كل المنشورات
app.get('/api/posts', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50
    const skip = parseInt(req.query.skip) || 0
    const currentUserId = req.query.userId || ''

    const sortedPosts = [...posts]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(skip, skip + limit)

    const postsWithDetails = sortedPosts.map(post => {
      const postId = post.id || post._id
      const postComments = comments.filter(c => c.postId === postId || c.postId === post.id || c.postId === post._id)
      const likeCount = postLikes.filter(l => l.postId === postId || l.postId === post.id || l.postId === post._id).length
      // تحديد liked بناءً على ما إذا كان المستخدم الحالي قد أعجب بالمنشور
      const userHasLiked = postLikes.some(l =>
        (l.postId === postId || l.postId === post.id || l.postId === post._id) &&
        l.userId === currentUserId
      )
      return {
        ...post,
        comments: postComments,
        likes: likeCount,
        liked: userHasLiked
      }
    })

    res.json({ success: true, posts: postsWithDetails })
  } catch (error) {
    console.error('Error fetching posts:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Stories API
app.post("/api/stories", upload.single("media"), handleCreateStory)
app.get("/api/stories/active", handleGetActiveStories)
app.delete("/api/stories/:storyId", handleDeleteStory)

// POST /api/posts - إنشاء منشور جديد
app.post("/api/posts", upload.fields([
  { name: "image", maxCount: 1 },
  { name: "video", maxCount: 1 }
]), (req, res) => {
  try {
    const { userId, username, avatar, content, duration } = req.body

    let mediaUrl = null
    let mediaType = null

    if (req.files && req.files.image && req.files.image[0]) {
      mediaUrl = `/uploads/${req.files.image[0].filename}`
      mediaType = "image"
      console.log("🖼️ Image uploaded:", req.files.image[0].filename)
    } else if (req.files && req.files.video && req.files.video[0]) {
      mediaUrl = `/uploads/${req.files.video[0].filename}`
      mediaType = "video"
      console.log("🎥 Video uploaded:", req.files.video[0].filename)
    }

    const post = {
      id: uuidv4(),
      userId: userId || "1",
      username: username || "مستخدم",
      avatar: avatar || "👤",
      content: content || "",
      mediaUrl,
      mediaType,
      duration: duration ? parseInt(duration) : null,
      likes: 0,
      comments: [],
      createdAt: new Date().toISOString()
    }

    posts.unshift(post)
    console.log("📝 New post created:", post.id, "| media:", mediaType || "none")

// إرسال إشعار فوري لكل المتصلين عبر WebSocket
    broadcastWS({
      type: 'NEW_POST',
      payload: post
    })

    res.json({ success: true, post })
  } catch (error) {
    console.error('Error creating post:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})


// POST /api/posts/:postId/comments - إضافة تعليق
app.post('/api/posts/:postId/comments', (req, res) => {
  try {
    const { postId } = req.params
    const { userId, username, content } = req.body

    const post = posts.find(p => p.id === postId)
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post not found' })
    }

    const comment = {
      _id: uuidv4(),
      id: uuidv4(),
      postId,
      userId,
      username,
      content,
      createdAt: new Date().toISOString()
    }

    comments.push(comment)
    console.log('💬 New comment:', comment._id)

    broadcastWS({
      type: 'NEW_COMMENT',
      payload: { postId, commentId: comment._id, comment }
    })

    res.json({ success: true, comment })
  } catch (error) {
    console.error('Error adding comment:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// POST /api/posts/:postId/like - إعجاب / إلغاء إعجاب
app.post('/api/posts/:postId/like', (req, res) => {
  try {
    const { postId } = req.params
    const { userId, username } = req.body

    const existingIndex = postLikes.findIndex(l => l.postId === postId && l.userId === userId)

    let liked
    if (existingIndex !== -1) {
      postLikes.splice(existingIndex, 1)
      liked = false
    } else {
      postLikes.push({ postId, userId, username })
      liked = true
    }

    const likeCount = postLikes.filter(l => l.postId === postId).length

    broadcastWS({
      type: liked ? 'POST_LIKED' : 'POST_UNLIKED',
      payload: { postId, userId, username, likes: likeCount }
    })

    res.json({ success: true, likes: likeCount, liked })
  } catch (error) {
    console.error('Error toggling like:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// DELETE /api/posts/:postId - حذف منشور
app.delete('/api/posts/:postId', (req, res) => {
  try {
    const { postId } = req.params
    const { userId } = req.body

    const index = posts.findIndex(p => p.id === postId)
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Post not found' })
    }

    posts.splice(index, 1)
    comments = comments.filter(c => c.postId !== postId)
    postLikes = postLikes.filter(l => l.postId !== postId)

    console.log('🗑️ Post deleted:', postId)

    broadcastWS({
      type: 'POST_DELETED',
      payload: { postId }
    })

    res.json({ success: true })
  } catch (error) {
    console.error('Error deleting post:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ============================================
// Users Profile API
// ============================================

// GET /api/users/:userId - جلب بيانات المستخدم
app.get('/api/users/:userId', (req, res) => {
  try {
    const { userId } = req.params
    const user = users[userId] || {
      id: userId,
      username: 'مستخدم ' + userId.substring(5, 11),
      avatar: '👤'
    }
    res.json({ success: true, user })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// POST /api/users/profile - تحديث الصورة الشخصية والاسم
app.post('/api/users/profile', upload.single('avatar'), (req, res) => {
  try {
    const { userId, username } = req.body
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId' })
    }

    let avatarUrl = users[userId]?.avatar || '👤'

    if (req.file) {
      avatarUrl = `/uploads/${req.file.filename}`
      console.log(`🖼️ Avatar updated for user ${userId}: ${req.file.filename}`)
    }

    // تحديث بيانات المستخدم في الذاكرة
    users[userId] = {
      id: userId,
      username: username || users[userId]?.username || ('مستخدم ' + userId.substring(5, 11)),
      avatar: avatarUrl,
      lastSeen: new Date().toISOString()
    }

    // إرسال إشعار فوري بتحديث البيانات
    broadcastWS({
      type: 'USER_INFO_UPDATED',
      payload: { userId, username: users[userId].username, avatar: avatarUrl }
    })

    res.json({ success: true, user: users[userId] })
  } catch (error) {
    console.error('❌ Error updating profile:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// GET /api/notifications/:userId
app.get('/api/notifications/:userId', (req, res) => {
  try {
    const { userId } = req.params
    const userNotifications = notifications
      .filter(n => n.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 50)
    res.json({ success: true, notifications: userNotifications })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// ============================================
// 📤 Chat Media Upload API (E2EE friendly)
// ============================================

// POST /api/chat/media - Upload media file for chat (returns URL only)
app.post('/api/chat/media', upload.single('media'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No media file uploaded' })
    }

    const mediaUrl = `/uploads/${req.file.filename}`
    console.log('📤 Chat media uploaded:', req.file.filename, '->', mediaUrl)

    res.json({
      success: true,
      mediaUrl,
      mediaType: req.file.mimetype.startsWith('image/') ? 'image' :
                 req.file.mimetype.startsWith('video/') ? 'video' : 'file'
    })
  } catch (error) {
    console.error('❌ Error uploading chat media:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ============================================
// 💬 Direct Messages API
// ============================================

// GET /api/messages - جلب رسائل المحادثة بين مستخدمين
app.get('/api/messages', (req, res) => {
  try {
    const { currentUserId, contactId } = req.query
    if (!currentUserId || !contactId) {
      return res.status(400).json({ success: false, error: 'currentUserId and contactId are required' })
    }
    const messages = getDirectMessages(currentUserId, contactId)
    res.json({ success: true, messages })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// POST /api/messages - إرسال رسالة (نص أو وسائط مشفرة E2EE)
app.post('/api/messages', upload.single('media'), (req, res) => {
  try {
    const { senderId, recipientId, type, clientTempId, enc, encIV, encCiphertextB64, encAlg, encKind, encAAD } = req.body
    const sender = users[senderId] || { username: 'مستخدم', avatar: '👤' }

    let mediaUrl = null
    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`
    }

    // ✅ FIX: Reconstruct enc object from separate fields (for E2EE media)
    // ✅ Now supports both AES-GCM (iv) and XSalsa20-Poly1305 (nonce)
    let encObj = null
    if ((encIV || encNonce) && encCiphertextB64) {
      const isXSalsa = encAlg === 'XSalsa20-Poly1305'
      encObj = {
        v: encVersion ? parseInt(encVersion) : (isXSalsa ? 2 : 1),
        kind: encKind || 'file',
        alg: encAlg || (isXSalsa ? 'XSalsa20-Poly1305' : 'AES-256-GCM'),
        [isXSalsa ? 'nonce' : 'iv']: isXSalsa ? encNonce : encIV,
        ciphertextB64: encCiphertextB64,
        aad: encAAD || clientTempId || ''
      }
    } else if (enc) {
      // Fallback: parse enc if sent as JSON string
      try {
        encObj = typeof enc === 'string' ? JSON.parse(enc) : enc
      } catch (e) {
        encObj = enc
      }
    }

    const message = {
      id: uuidv4(),
      senderId,
      recipientId,
      senderName: sender.username,
      senderAvatar: sender.avatar,
      content: req.body.content || '',
      type: type || 'text',
      mediaUrl,
      enc: encObj,
      timestamp: Date.now()
    }

    directMessages.push(message)
    console.log('💬 New direct message:', message.id, 'from', senderId, 'to', recipientId, 'type:', type, 'hasEnc:', !!encObj)

    // Broadcast to BOTH sender AND recipient via WebSocket
    broadcastDM(message)

    res.json({ success: true, message })
  } catch (error) {
    console.error('❌ Error sending message:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Broadcast direct message to both parties
function broadcastDM(message) {
  const data = JSON.stringify({
    type: 'NEW_MESSAGE',
    payload: {
      id: message.id,
      senderId: message.senderId,
      recipientId: message.recipientId,
      senderName: message.senderName,
      senderAvatar: message.senderAvatar,
      content: message.content,
      type: message.type,
      mediaUrl: message.mediaUrl,
      enc: message.enc,
      senderSeedB64: message.senderSeedB64,
      timestamp: message.timestamp
    }
  })

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const clientUserId = onlineUsers.get(client)?.userId
      if (clientUserId === message.senderId || clientUserId === message.recipientId) {
        client.send(data)
        console.log('  → Sent to user:', clientUserId)
      }
    }
  })
}

// ============================================
// 🤖 OpenRouter AI Proxy — آمن وموثوق
// ============================================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'qwen/qwen-2.5-72b-instruct'
const OPENROUTER_URL     = 'https://openrouter.ai/api/v1/chat/completions'

// POST /api/ai/chat — وكيل آمن لـ OpenRouter
app.post('/api/ai/chat', async (req, res) => {
  try {
    if (!OPENROUTER_API_KEY) {
      console.error('❌ OPENROUTER_API_KEY غير مكوّن في .env')
      return res.status(500).json({
        success: false,
        error: 'OpenRouter API key not configured — أضف OPENROUTER_API_KEY في ملف .env'
      })
    }

    const { messages, stream = false, temperature = 0.7, max_tokens = 2000 } = req.body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'messages array is required' })
    }

    console.log(`🤖 AI: ${messages.length} رسالة → ${OPENROUTER_MODEL} (stream=${stream})`)

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3001',
        'X-Title': 'Spider Social Platform'
      },
      body: JSON.stringify({ model: OPENROUTER_MODEL, messages, temperature, max_tokens, stream })
    })

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}))
      const errMsg = errData?.error?.message || `HTTP ${response.status}: ${response.statusText}`
      console.error('❌ OpenRouter:', response.status, errMsg)

      // رسائل خطأ مفهومة
      let userMsg = errMsg
      if (response.status === 401) userMsg = 'مفتاح OpenRouter غير صالح — جدّده في .env'
      if (response.status === 402) userMsg = 'رصيد OpenRouter منتهٍ — أضف رصيداً على openrouter.ai'
      if (response.status === 429) userMsg = 'تجاوزت حد الطلبات — انتظر قليلاً'

      return res.status(response.status).json({ success: false, error: userMsg })
    }

    if (stream) {
      // ─── وضع Streaming ───
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.flushHeaders()

      // تمرير stream مباشرة للمتصفح
      response.body.on('data', chunk => res.write(chunk))
      response.body.on('end',  () => { res.write('data: [DONE]\n\n'); res.end() })
      response.body.on('error', err => { console.error('Stream err:', err); res.end() })

    } else {
      // ─── وضع عادي ───
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content || ''
      console.log('✅ رد AI:', content.substring(0, 80))
      res.json({ success: true, content, model: OPENROUTER_MODEL })
    }

  } catch (error) {
    console.error('❌ AI proxy error:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})



// ============================================
// Group Chat API
// ============================================

// GET /api/groups - جلب مجموعات المستخدم
app.get('/api/groups', (req, res) => {
  try {
    const { userId } = req.query
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId required' })
    }

    const userGroups = groups.filter(g => g.members.some(m => m.userId === userId))
    res.json({ success: true, groups: userGroups })
  } catch (error) {
    console.error('❌ Error fetching groups:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// GET /api/groups/:groupId/messages - جلب رسائل المجموعة
app.get('/api/groups/:groupId/messages', (req, res) => {
  try {
    const { groupId } = req.params
    const { userId } = req.query

    const group = groups.find(g => g.id === groupId)
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found' })
    }

    // Check if user is member
    if (!group.members.some(m => m.userId === userId)) {
      return res.status(403).json({ success: false, error: 'Not a member of this group' })
    }

    const messages = groupMessages[groupId] || []
    res.json({ success: true, messages })
  } catch (error) {
    console.error('❌ Error fetching group messages:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// POST /api/group-messages - إرسال رسالة وسائط للمجموعة
app.post('/api/group-messages', upload.single('media'), (req, res) => {
  try {
    const { senderId, senderName, groupId, type } = req.body

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No media file uploaded.' })
    }

    const group = groups.find(g => g.id === groupId)
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found' })
    }

    const mediaUrl = `/uploads/${req.file.filename}`

    const message = {
      id: uuidv4(),
      groupId,
      senderId,
      senderName: senderName || 'مستخدم',
      content: '',
      type: type || (req.file.mimetype.startsWith('image/') ? 'image' : req.file.mimetype.startsWith('video/') ? 'video' : 'file'),
      mediaUrl,
      timestamp: Date.now()
    }

    if (!groupMessages[groupId]) {
      groupMessages[groupId] = []
    }
    groupMessages[groupId].push(message)

    // Broadcast to group members
    const data = JSON.stringify({
      type: 'NEW_GROUP_MESSAGE',
      payload: message
    })

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && group.members.some(m => m.userId === client.userId)) {
        client.send(data)
      }
    })

    console.log('📨 Group media message sent:', message.id, 'to group:', groupId)
    res.json({ success: true, message })
  } catch (error) {
    console.error('❌ Error sending group media message:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    posts: posts.length,
    groups: groups.length,
    clients: wss ? wss.clients.size : 0,
    uptime: process.uptime()
  })
})

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir))

// ============================================
// WebSocket Server (same port as HTTP)
// ============================================
const server = createServer(app)
const wss = new WebSocketServer({ server })

// إرسال رسالة لكل المتصلين
function broadcastWS(message, excludeWs = null) {
  const data = JSON.stringify(message)
  let sentCount = 0
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data)
      sentCount++
    }
  })
  if (message.type) {
    console.log(`  → Broadcast ${message.type} to ${sentCount} client(s)`)
  }
}

wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection from:', req.socket.remoteAddress)
  ws.isAlive = true

  // إرسال رسالة ترحيب
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    payload: { message: 'Connected to Spider Server ✅' }
  }))

  ws.on('pong', () => {
    ws.isAlive = true
  })

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message)
      console.log('📨 WS Message:', data.type)

      switch (data.type) {
        case 'AUTH':
          ws.userId = data.payload?.userId
          ws.send(JSON.stringify({
            type: 'AUTH_SUCCESS',
            payload: { userId: ws.userId }
          }))
          break

        case 'PING':
          ws.send(JSON.stringify({ type: 'PONG' }))
          break

        case 'NEW_POST':
          // البث لبقية المتصلين (ليس المُرسِل)
          broadcastWS(data, ws)
          break

        case 'SUBSCRIBE':
          ws.room = data.payload?.roomId
          break

        case 'ADD_COMMENT':
          try {
            const { postId, userId, username, content, postOwnerId } = data.payload || {}

            if (!postId || !userId || !content) {
              ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Missing comment data' } }))
              break
            }

            // Check if post exists (supports both id and _id)
            const post = posts.find(p => p.id === postId || p._id === postId)
            if (!post) {
              ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Post not found' } }))
              break
            }

            const comment = {
              _id: uuidv4(),
              id: uuidv4(),
              postId,
              userId,
              username: username || 'مستخدم',
              content,
              createdAt: new Date().toISOString()
            }

            comments.push(comment)
            console.log('💬 WS Comment added:', comment._id, 'by', username, 'on post:', postId)

            // Broadcast to ALL clients including sender (so sender sees their own comment)
            broadcastWS({
              type: 'NEW_COMMENT',
              payload: { postId, commentId: comment._id, comment }
            })

            ws.send(JSON.stringify({ type: 'COMMENT_ADDED', payload: { success: true, comment } }))
          } catch (err) {
            console.error('❌ Error adding comment via WS:', err)
            ws.send(JSON.stringify({ type: 'ERROR', payload: { message: err.message } }))
          }
          break

        case 'DELETE_COMMENT':
          try {
            const { postId, commentId, userId } = data.payload || {}
            const commentIdx = comments.findIndex(c => (c._id === commentId || c.id === commentId) && c.userId === userId)

            if (commentIdx === -1) {
              ws.send(JSON.stringify({ type: 'comment_delete_failed' }))
              break
            }

            comments.splice(commentIdx, 1)
            console.log('🗑️ WS Comment deleted:', commentId)

            broadcastWS({
              type: 'COMMENT_DELETED',
              payload: { postId, commentId }
            })

            ws.send(JSON.stringify({ type: 'COMMENT_DELETED', payload: { success: true, commentId } }))
          } catch (err) {
            console.error('❌ Error deleting comment via WS:', err)
            ws.send(JSON.stringify({ type: 'comment_delete_failed' }))
          }
          break

        case 'UPDATE_COMMENT':
          try {
            const { postId, commentId, userId, newContent } = data.payload || {}
            const commentIdx = comments.findIndex(c => (c._id === commentId || c.id === commentId) && c.userId === userId)

            if (commentIdx === -1) {
              ws.send(JSON.stringify({ type: 'comment_update_failed' }))
              break
            }

            comments[commentIdx].content = newContent
            console.log('✏️ WS Comment updated:', commentId)

            broadcastWS({
              type: 'COMMENT_UPDATED',
              payload: { postId, commentId, comment: comments[commentIdx] }
            })

            ws.send(JSON.stringify({ type: 'COMMENT_UPDATED', payload: { success: true, comment: comments[commentIdx] } }))
          } catch (err) {
            console.error('❌ Error updating comment via WS:', err)
            ws.send(JSON.stringify({ type: 'comment_update_failed' }))
          }
          break

        case 'CALL_SIGNAL':
          console.log(`📞 CALL_SIGNAL: ${data.payload?.type} from ${ws.userId} to ${data.payload?.recipientId}`)
          broadcastWS(data, ws)
          break

        case 'CREATE_GROUP':
          try {
            const { name, creatorId, members } = data.payload
            const group = {
              id: uuidv4(),
              name: name || 'مجموعة جديدة',
              creatorId,
              members: members || [],
              createdAt: new Date().toISOString()
            }
            groups.push(group)
            groupMessages[group.id] = []

            console.log('👥 Group created:', group.id, 'with', group.members.length, 'members')

            // Notify all members
            const notifyData = JSON.stringify({
              type: 'GROUP_CREATED',
              payload: group
            })

            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && group.members.some(m => m.userId === client.userId)) {
                client.send(notifyData)
              }
            })

            ws.send(JSON.stringify({ type: 'GROUP_CREATE_SUCCESS', payload: group }))
          } catch (err) {
            console.error('❌ Error creating group:', err)
            ws.send(JSON.stringify({ type: 'GROUP_CREATE_ERROR', payload: { error: err.message } }))
          }
          break

        case 'SEND_GROUP_MESSAGE':
          try {
            const { groupId, senderId, senderName, content, type, mediaUrl } = data.payload
            const group = groups.find(g => g.id === groupId)

            if (!group) {
              ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Group not found' } }))
              break
            }

            // Check sender is member
            if (!group.members.some(m => m.userId === senderId)) {
              ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Not a member of this group' } }))
              break
            }

            const message = {
              id: uuidv4(),
              groupId,
              senderId,
              senderName: senderName || 'مستخدم',
              content: content || '',
              type: type || 'text',
              mediaUrl: mediaUrl || null,
              timestamp: Date.now()
            }

            if (!groupMessages[groupId]) {
              groupMessages[groupId] = []
            }
            groupMessages[groupId].push(message)

            console.log('💬 Group message:', message.id, 'in', groupId, 'by', senderName)

            // Send to all group members
            const msgData = JSON.stringify({
              type: 'NEW_GROUP_MESSAGE',
              payload: message
            })

            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && group.members.some(m => m.userId === client.userId)) {
                client.send(msgData)
              }
            })
          } catch (err) {
            console.error('❌ Error sending group message:', err)
          }
          break

        case 'ADD_GROUP_MEMBER':
          try {
            const { groupId, userId: newMemberId, username, avatar } = data.payload
            const group = groups.find(g => g.id === groupId)

            if (!group) {
              ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Group not found' } }))
              break
            }

            // Check if already member
            if (group.members.some(m => m.userId === newMemberId)) {
              break
            }

            group.members.push({
              userId: newMemberId,
              username: username || 'مستخدم',
              avatar: avatar || '👤',
              role: 'member',
              joinedAt: new Date().toISOString()
            })

            console.log('👤 Member added to group:', groupId, '-', newMemberId)

            // Notify all members
            const memberData = JSON.stringify({
              type: 'GROUP_MEMBER_ADDED',
              payload: { groupId, member: { userId: newMemberId, username, avatar } }
            })

            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && group.members.some(m => m.userId === client.userId)) {
                client.send(memberData)
              }
            })
          } catch (err) {
            console.error('❌ Error adding group member:', err)
          }
          break

        case 'LEAVE_GROUP':
          try {
            const { groupId, userId } = data.payload
            const group = groups.find(g => g.id === groupId)

            if (!group) break

            group.members = group.members.filter(m => m.userId !== userId)

            console.log('👋 User left group:', groupId, '-', userId)

            // If no members left, delete group
            if (group.members.length === 0) {
              groups = groups.filter(g => g.id !== groupId)
              delete groupMessages[groupId]
              console.log('🗑️ Group deleted (no members):', groupId)
            } else {
              // Notify remaining members
              const leaveData = JSON.stringify({
                type: 'GROUP_MEMBER_LEFT',
                payload: { groupId, userId }
              })

              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && group.members.some(m => m.userId === client.userId)) {
                  client.send(leaveData)
                }
              })
            }

            ws.send(JSON.stringify({ type: 'GROUP_LEFT_SUCCESS', payload: { groupId } }))
          } catch (err) {
            console.error('❌ Error leaving group:', err)
          }
          break

        case 'GET_GROUPS':
          try {
            const { userId } = data.payload
            const userGroups = groups.filter(g => g.members.some(m => m.userId === userId))
            ws.send(JSON.stringify({
              type: 'MY_GROUPS',
              payload: { groups: userGroups }
            }))
          } catch (err) {
            console.error('❌ Error getting groups:', err)
          }
          break

        case 'USER_ONLINE':
          try {
            const { userId, username, avatar } = data.payload
            if (userId) {
              onlineUsers.set(ws, { userId, username, avatar, joinedAt: new Date().toISOString() })
              // Broadcast to all OTHER clients that this user is online
              broadcastWS({
                type: 'USER_ONLINE',
                payload: { userId, username, avatar }
              }, ws)
              console.log('🟢 User online:', username || userId)
            }
          } catch (err) {
            console.error('❌ Error handling USER_ONLINE:', err)
          }
          break

        case 'USER_OFFLINE':
          try {
            const { userId } = data.payload
            if (userId) {
              onlineUsers.delete(ws)
              broadcastWS({
                type: 'USER_OFFLINE',
                payload: { userId }
              }, ws)
              console.log('🔴 User offline:', userId)
            }
          } catch (err) {
            console.error('❌ Error handling USER_OFFLINE:', err)
          }
          break

        case 'GET_ONLINE_USERS':
          try {
            const onlineList = Array.from(onlineUsers.values())
              .filter(u => u && u.userId)
              .map(u => ({
                userId: u.userId,
                username: u.username,
                avatar: u.avatar
              }))
            ws.send(JSON.stringify({
              type: 'ONLINE_USERS',
              payload: { onlineUsers: onlineList }
            }))
            console.log('📋 Sent online users list:', onlineList.length, 'users')
          } catch (err) {
            console.error('❌ Error getting online users:', err)
          }
          break

        case 'SEND_MESSAGE':
          try {
            const { id, senderId, recipientId, senderName, senderAvatar, content, type, enc, mediaUrl, senderSeedB64, timestamp } = data.payload || {}

            if (!senderId || !recipientId) {
              console.warn('⚠️ SEND_MESSAGE missing senderId or recipientId')
              break
            }

            // Store message in directMessages
            const message = {
              id: id || uuidv4(),
              senderId,
              recipientId,
              senderName: senderName || 'مستخدم',
              senderAvatar: senderAvatar || '👤',
              content: content || '',
              type: type || 'text',
              enc,
              mediaUrl: mediaUrl || null,
              senderSeedB64,
              timestamp: timestamp || Date.now()
            }

            directMessages.push(message)
            console.log('💬 WS Direct message stored:', message.id, 'from', senderId, 'to', recipientId, 'type:', type)

            // ✅ Broadcast to BOTH sender AND recipient via broadcastDM
            broadcastDM(message)

            // ✅ Also notify recipient to open chat window
            const chatNotifyData = JSON.stringify({
              type: 'OPEN_CHAT_WINDOW',
              payload: { fromUserId: senderId, fromUsername: message.senderName }
            })

            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                const clientUserId = onlineUsers.get(client)?.userId
                if (clientUserId === recipientId) {
                  client.send(chatNotifyData)
                  console.log('  → Notified', recipientId, 'to open chat window from', senderId)
                }
              }
            })

          } catch (err) {
            console.error('❌ Error handling SEND_MESSAGE:', err)
          }
          break

        default:
          // إعادة البث لبقية المتصلين
          broadcastWS(data, ws)
      }
    } catch (error) {
      console.error('Error parsing WS message:', error)
    }
  })

  ws.on('close', () => {
    console.log('🔌 WebSocket disconnected')
    
    // Broadcast USER_OFFLINE if this ws was tracked
    const userInfo = onlineUsers.get(ws)
    if (userInfo && userInfo.userId) {
      onlineUsers.delete(ws)
      broadcastWS({
        type: 'USER_OFFLINE',
        payload: { userId: userInfo.userId }
      })
      console.log('🔴 User went offline (disconnect):', userInfo.username || userInfo.userId)
    }
  })

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message)
  })
})

// Heartbeat - إبقاء الاتصالات حية
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      return ws.terminate()
    }
    ws.isAlive = false
    ws.ping()
  })
}, 30000)

// ============================================
// Start Server
// ============================================
server.listen(PORT, () => {
  console.log('\n🕷️  Spider Server Started!')
  console.log('================================')
  console.log(`📡 HTTP API:  http://localhost:${PORT}`)
  console.log(`⚡ WebSocket: ws://localhost:${PORT}`)
  console.log(`📁 Uploads:   http://localhost:${PORT}/uploads`)
  console.log(`🩺 Health:    http://localhost:${PORT}/health`)
  console.log('================================\n')
})

process.on('SIGTERM', () => {
  console.log('👋 Shutting down...')
  server.close(() => process.exit(0))
})
