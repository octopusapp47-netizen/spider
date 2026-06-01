/**
 * Spider News WebSocket Service
 * Native WebSocket client (NO Socket.io)
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Message queue for offline support
 * - Room subscriptions
 * - Heartbeat monitoring
 * - < 100ms latency
 */

// ✅ Use environment variables with proper fallbacks
import { WS_URL, HTTP_URL, detectServerUrl } from '@/config'

// Posts-only robustness fix: detection helper sometimes fails on Android networks
// after USB disconnect, so createPost() retries with a discovery fallback.

console.log('🔧 WebSocketService initialized:')
console.log('   WS_URL:', WS_URL)
console.log('   HTTP_URL:', HTTP_URL)

class WebSocketService {
  constructor() {
    this.ws = null
    this.userId = null
    this.connected = false
    this.reconnectAttempts = 0
    this.maxReconnects = 10
    this.reconnectDelay = 1000
    this.messageQueue = []
    this.subscribedRooms = new Set()
    this.listeners = new Map()
    this.heartbeatInterval = null
    this.heartbeatTimeout = null
    this.connectionTimeout = null

    // Mobile network detection
    this.isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    this.wasOffline = false

    // Mobile: Listen for network status changes
    if (this.isMobileDevice) {
      window.addEventListener('online', () => this.handleNetworkOnline())
      window.addEventListener('offline', () => this.handleNetworkOffline())
    }

    // Auto-connect
    this.connect()
  }

  // Mobile: Handle network coming back online
  handleNetworkOnline() {
    console.log('📱 Network online, attempting reconnection...')
    this.wasOffline = false

    // Clear any existing connection and retry
    if (this.ws) {
      this.ws.close()
    }

    // Try server discovery first (in case IP changed after network switch)
    this.discoverAndConnect()
  }

  // Mobile: Handle network going offline
  handleNetworkOffline() {
    console.log('📱 Network offline')
    this.wasOffline = true
    this.wasDisconnected = true
  }

  // ============================================
  // Connection Management
  // ============================================

  // Current WebSocket URL (may change after discovery)
  currentWsUrl = WS_URL
  discoveredWsUrl = null
  discoveredHttpUrl = null

  connect(useDiscoveredUrl = false) {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log('WebSocket already connecting or connected')
      return
    }

    const urlToConnect = useDiscoveredUrl && this.discoveredWsUrl ? this.discoveredWsUrl : this.currentWsUrl

    try {
      console.log('Connecting to WebSocket:', urlToConnect)
      this.ws = new WebSocket(urlToConnect)

      // Connection timeout
      this.connectionTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
          console.warn('Connection timeout, closing...')
          this.ws.close()
        }
      }, 10000)

      this.ws.onopen = () => {
        clearTimeout(this.connectionTimeout)
        console.log('WebSocket connected')
        this.connected = true
        this.reconnectAttempts = 0
        this.reconnectDelay = 1000

        // Emit CONNECTED event for stores that are listening
        this.emit('CONNECTED', { message: 'Connected to Spider Server' })

        // Authenticate if userId is set
        if (this.userId) {
          this.authenticate()
        }

        // Resubscribe to rooms
        this.resubscribeRooms()

        // Process queued messages
        this.processQueue()

        // Start heartbeat
        this.startHeartbeat()
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          console.log('Received:', data.type)
          this.handleMessage(data)
        } catch (error) {
          console.error('Error parsing message:', error)
        }
      }

      this.ws.onclose = () => {
        clearTimeout(this.connectionTimeout)
        console.log('WebSocket disconnected')
        this.connected = false
        this.stopHeartbeat()
        this.scheduleReconnect()
      }

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error)
      }
    } catch (error) {
      console.error('Failed to connect WebSocket:', error)
      this.scheduleReconnect()
    }
  }

  async discoverAndConnect() {
    if (this.discoveredWsUrl) {
      this.connect(true)
      return
    }

    console.log('Discovering server...')
    const discovered = await detectServerUrl()

    if (discovered) {
      const wsProtocol = discovered.startsWith('https') ? 'wss:' : 'ws:'
      this.discoveredWsUrl = discovered.replace(/^http/, wsProtocol)
      this.discoveredHttpUrl = discovered

      console.log('Discovered server, connecting to:', this.discoveredWsUrl)
      this.connect(true)
    } else {
      console.error('Could not discover server')
      this.emit('SERVER_NOT_FOUND', { message: 'Could not connect to server. Make sure the server is running on your PC.' })
    }
  }

  authenticate() {
    if (!this.userId) {
      console.warn('⚠️ No userId to authenticate')
      return
    }

    this.send({
      type: 'AUTH',
      payload: {
        userId: this.userId,
        username: this.username || 'مستخدم',
        avatar: this.avatar || '👤'
      }
    })
  }

  setUserInfo(username, avatar) {
    this.username = username
    this.avatar = avatar
    if (this.connected) {
      this.authenticate()
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnects) {
      console.error('Max reconnect attempts reached, trying server discovery...')
      // Try server discovery as last resort
      this.discoverAndConnect()
      return
    }

    this.reconnectAttempts++
    console.log(`Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnects})`)

    setTimeout(() => {
      this.connect()
    }, this.reconnectDelay)

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
  }

  // ============================================
  // Heartbeat System
  // ============================================

  startHeartbeat() {
    // Send ping every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.connected && this.ws) {
        this.send({ type: 'PING' })
        
        // Expect pong within 10 seconds
        this.heartbeatTimeout = setTimeout(() => {
          console.warn('⚠️ Heartbeat timeout, reconnecting...')
          this.ws.close()
        }, 10000)
      }
    }, 30000)
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = null
    }
  }

  handlePong() {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout)
      this.heartbeatTimeout = null
    }
  }

  // ============================================
  // Room Subscription
  // ============================================

  subscribe(roomId) {
    if (this.subscribedRooms.has(roomId)) return

    this.subscribedRooms.add(roomId)
    
    if (this.connected) {
      this.send({
        type: 'SUBSCRIBE',
        payload: { roomId }
      })
    }
  }

  unsubscribe(roomId) {
    this.subscribedRooms.delete(roomId)
    
    if (this.connected) {
      this.send({
        type: 'UNSUBSCRIBE',
        payload: { roomId }
      })
    }
  }

  resubscribeRooms() {
    this.subscribedRooms.forEach(roomId => {
      this.send({
        type: 'SUBSCRIBE',
        payload: { roomId }
      })
    })
  }

  // ============================================
  // Message Handling
  // ============================================

  handleMessage(data) {
    switch (data.type) {
      case 'CONNECTED':
        console.log('✅', data.payload.message)
        break

      case 'AUTH_SUCCESS':
        console.log('✅ Authenticated as:', data.payload.userId)
        break

      case 'PONG':
        this.handlePong()
        break

      case 'NEW_POST':
        this.emit('new_post', data.payload)
        break

      case 'NEW_COMMENT':
        this.emit('new_comment', data.payload)
        break

      case 'COMMENT_DELETED':
        this.emit('comment_deleted', data.payload)
        break

      case 'COMMENT_UPDATED':
        this.emit('comment_updated', data.payload)
        break


      case 'POST_LIKED':
        this.emit('post_liked', data.payload.postId || data.payload._id, data.payload.userId, data.payload.username)
        break

      case 'POST_UNLIKED':
        this.emit('post_unliked', data.payload.postId || data.payload._id, data.payload.userId)
        break

      case 'POST_DELETED':
        this.emit('post_deleted', data.payload.postId || data.payload._id)
        break

      case 'NEW_STORY':
        this.emit('NEW_STORY', data.payload)
        break

      case 'STORY_DELETED':
        this.emit('STORY_DELETED', data.payload)
        break

      case 'NEW_MESSAGE':
        this.emit('NEW_MESSAGE', data.payload)
        break

      case 'MESSAGE_EDITED':
        this.emit('MESSAGE_EDITED', data.payload)
        break

      case 'MESSAGE_DELETED':
        this.emit('MESSAGE_DELETED', data.payload)
        break

      case 'USER_ONLINE':
        this.emit('USER_ONLINE', data.payload)
        break

      case 'USER_OFFLINE':
        this.emit('USER_OFFLINE', data.payload)
        break

      case 'ONLINE_USERS':
        this.emit('ONLINE_USERS', data.payload)
        break

      case 'FRIEND_ADDED':
        this.emit('FRIEND_ADDED', data.payload)
        break

      case 'MY_FRIENDS':
        this.emit('MY_FRIENDS', data.payload)
        break

      case 'USER_INFO_UPDATED':
        this.emit('USER_INFO_UPDATED', data.payload)
        break

      case 'CALL_SIGNAL':
        this.emit('call_signal', data.payload)
        break

      case 'ERROR':
        console.error('❌ Server error:', data.payload.message)
        this.emit('error', data.payload)
        break

      default:
        console.log('📨 Unknown message type:', data.type)
    }
  }

  // ============================================
  // Event System
  // ============================================

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event).add(callback)
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback)
    }
  }

  emit(event, ...args) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => {
        try {
          callback(...args)
        } catch (error) {
          console.error('❌ Error in event listener:', error)
        }
      })
    }
  }

  // ============================================
  // Send Messages
  // ============================================

  send(data) {
    const payload = {
      ...data,
      timestamp: Date.now()
    }

    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    } else {
      // Queue for later
      this.queueMessage(payload)
    }
  }

  queueMessage(message) {
    this.messageQueue.push(message)
    console.log('📝 Queued message:', message.type)
  }

  processQueue() {
    if (this.messageQueue.length === 0) return

    console.log('🔄 Processing queue:', this.messageQueue.length, 'messages')

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift()
      this.ws.send(JSON.stringify(message))
    }
  }

  // ============================================
  // API Methods (WebSocket + HTTP Fallback)
  // ============================================

  async createPost(postData, retryCount = 0, serverUrl = HTTP_URL) {
    // Posts-only fix: improve resilience when phone USB/network changes.
    // Mobile has longer timeout and more retries
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const timeoutMs = isMobileDevice ? 60000 : 30000; // 60s for mobile, 30s for desktop
    const maxRetries = isMobileDevice ? 4 : 2;

    console.log('📝 Creating post...', {
      hasImage: postData.image instanceof File,
      hasVideo: postData.video instanceof File,
      retryCount,
      isMobileDevice,
      HTTP_URL,
      serverUrl
    })


    // Always use HTTP for file uploads (WebSocket can't send files)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const formData = new FormData()
      formData.append('userId', postData.userId)
      formData.append('username', postData.username)
      formData.append('avatar', postData.avatar || '👤')
      formData.append('content', postData.content || '')

      // Handle image file
      if (postData.image instanceof File) {
        formData.append('image', postData.image)
        console.log('🖼️ Appending image:', postData.image.name)
      }

      // Handle video file
      if (postData.video instanceof File) {
        formData.append('video', postData.video)
        console.log('🎥 Appending video:', postData.video.name)
      }

      if (postData.duration) formData.append('duration', postData.duration)

      let response
      try {
        response = await fetch(`${serverUrl}/api/posts`, {
          method: 'POST',
          body: formData,
          signal: controller.signal
        })
      } catch (fetchErr) {
        // Network error / timeout / aborted.
        // Mobile: detect CORS errors specifically and provide better error messaging
        const isNetworkError = fetchErr.name === 'TypeError' && fetchErr.message.includes('fetch')
        const isCORSError = fetchErr.message.includes('Failed to fetch') || fetchErr.message.includes('NetworkError') || fetchErr.message.includes('CORS')

        if (isCORSError) {
          console.warn('⚠️ CORS error detected on mobile, trying server discovery...', fetchErr.message)
        }

        if (retryCount < maxRetries) {
          console.warn('⚠️ createPost network/timeout error, trying server discovery/fallback...', {
            message: fetchErr?.message,
            retryCount,
            maxRetries,
            isCORSError,
            HTTP_URL,
            serverUrl
          })

          try {
            const discoveredUrl = await detectServerUrl()
            if (discoveredUrl && discoveredUrl !== serverUrl) {
              console.log('🔄 Retrying createPost with discovered server URL:', discoveredUrl)
              return this.createPost(postData, retryCount + 1, discoveredUrl)
            }
          } catch (e) {
            console.warn('❌ Server discovery failed during createPost retry:', e)
          }
        }

        throw fetchErr
      } finally {
        clearTimeout(timeout)
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')

        // Handle rate limit (429) with automatic retry
        if (response.status === 429 && retryCount < maxRetries) {
          const delayMs = (retryCount + 1) * (isMobileDevice ? 8000 : 5000) // Longer for mobile
          console.warn(`⏳ Rate limited (429). Retrying in ${delayMs}ms (attempt ${retryCount + 1}/3)...`)

          await new Promise(resolve => setTimeout(resolve, delayMs))
          return this.createPost(postData, retryCount + 1, serverUrl)
        }

        // If primary URL fails, try discovery (useful after USB disconnect/network change)
        if (retryCount < maxRetries && serverUrl === HTTP_URL) {
          console.warn('⚠️ createPost HTTP failure on primary URL, trying discovery...', {
            status: response.status,
            serverUrl
          })

          try {
            const discoveredUrl = await detectServerUrl()
            if (discoveredUrl && discoveredUrl !== HTTP_URL) {
              console.log('🔄 Retrying createPost with discovered server URL:', discoveredUrl)
              return this.createPost(postData, retryCount + 1, discoveredUrl)
            }
          } catch (e) {
            console.warn('❌ Server discovery failed after HTTP failure:', e)
          }
        }

        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const result = await response.json()

      if (result.success && result.post) {
        console.log('✅ Post created via HTTP:', result.post.id)
        console.log('   mediaUrl:', result.post.mediaUrl)
        console.log('   mediaType:', result.post.mediaType)
        return result.post
      } else {
        console.error('❌ Server returned invalid post:', result)
        throw new Error('Server returned invalid post object')
      }
    } catch (error) {
      console.error('❌ createPost error:', error)
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async addComment(postId, userId, username, content, postOwnerId = null) {
    // ✅ Use HTTP ONLY to avoid double-broadcast (WS handler also broadcasts NEW_COMMENT)
    // This prevents comments from appearing twice
    try {
      const response = await fetch(`${HTTP_URL}/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, username, content })
      })

      const result = await response.json()

      if (result.success) {
        return result.comment
      }
    } catch (error) {
      console.error('❌ addComment failed:', error)
    }

    return null
  }

  async deleteComment(postId, commentId, userId) {
    // Send via WebSocket
    this.send({
      type: 'DELETE_COMMENT',
      payload: { postId, commentId, userId }
    })

    // Fallback: HTTP (not implemented on server.js)
    return true
  }

  async updateComment(postId, commentId, userId, newContent) {
    // Send via WebSocket
    this.send({
      type: 'UPDATE_COMMENT',
      payload: { postId, commentId, userId, newContent }
    })

    // Fallback: HTTP (not implemented on server.js)
    return true
  }


  async likePost(postId, userId, username, postOwnerId = null) {
    // Send via WebSocket
    this.send({
      type: 'LIKE_POST',
      payload: {
        postId,
        userId,
        username,
        postOwnerId
      }
    })

    // Fallback: HTTP
    try {
      const response = await fetch(`${HTTP_URL}/api/posts/${postId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, username })
      })

      const result = await response.json()
      
      if (result.success) {
        return { likes: result.likes, liked: result.liked }
      }
    } catch (error) {
      console.error('❌ HTTP fallback failed:', error)
    }

    return null
  }

  async deletePost(postId, userId) {
    // Send via WebSocket
    this.send({
      type: 'DELETE_POST',
      payload: { postId, userId }
    })

    // Fallback: HTTP
    try {
      const response = await fetch(`${HTTP_URL}/api/posts/${postId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      })

      const result = await response.json()

      if (result.success) {
        return true
      }
    } catch (error) {
      console.error('❌ HTTP fallback failed:', error)
    }

    return false
  }

  async deleteAllUserPosts(userId) {
    try {
      const response = await fetch(`${HTTP_URL}/api/posts/user/${userId}`, {
        method: 'DELETE'
      })
      const result = await response.json()
      if (result.success) {
        console.log(`✅ Deleted ${result.deletedPosts} posts and ${result.deletedMedia} media files`)
        return result
      }
      return { success: false, error: result.error }
    } catch (error) {
      console.error('❌ Error deleting user posts:', error)
      return { success: false, error: error.message }
    }
  }

  async deleteAllUserMessages(userId) {
    try {
      const response = await fetch(`${HTTP_URL}/api/messages/user/${userId}`, { method: 'DELETE' })
      return await response.json()
    } catch (error) {
      console.error('❌ Error deleting user messages:', error)
      return { success: false, error: error.message }
    }
  }

  async deleteUserFriends(userId) {
    try {
      const response = await fetch(`${HTTP_URL}/api/friends/user/${userId}`, { method: 'DELETE' })
      return await response.json()
    } catch (error) {
      console.error('❌ Error deleting user friends:', error)
      return { success: false, error: error.message }
    }
  }

  async nukeAllUserData(userId) {
    try {
      const response = await fetch(`${HTTP_URL}/api/user/${userId}`, { method: 'DELETE' })
      const result = await response.json()
      if (result.success) {
        console.log(`💥 Nuked ${result.deletedPosts} posts, ${result.deletedMedia} media, ${result.deletedMessages} messages`)
      }
      return result
    } catch (error) {
      console.error('❌ Error nuking user data:', error)
      return { success: false, error: error.message }
    }
  }

  async getPosts(limit = 50, skip = 0, serverUrl = HTTP_URL) {
    try {
      const userId = this.userId || localStorage.getItem('spider_user_id') || ''
      const response = await fetch(`${serverUrl}/api/posts?limit=${limit}&skip=${skip}&userId=${encodeURIComponent(userId)}`)
      const result = await response.json()

      if (result.success) {
        return result.posts
      }
      return []
    } catch (error) {
      console.error('❌ Error fetching posts:', error)

      // Retry with discovered server URL if this is the first failure
      if (serverUrl === HTTP_URL) {
        try {
          const discoveredUrl = await detectServerUrl()
          if (discoveredUrl && discoveredUrl !== HTTP_URL) {
            console.log('🔄 Retrying getPosts with discovered server URL:', discoveredUrl)
            return this.getPosts(limit, skip, discoveredUrl)
          }
        } catch (e) {
          console.warn('❌ Server discovery failed:', e)
        }
      }

      return []
    }
  }

  // ============================================
  // Stories API
  // ============================================

  async createStory(storyData) {
    console.log('📸 Creating story via Backend...', storyData)

    try {
      const formData = new FormData()
      formData.append('userId', storyData.userId)
      formData.append('username', storyData.username)
      formData.append('avatar', storyData.avatar || '👤')
      formData.append('description', storyData.description || '')

      // Handle media file
      if (storyData.mediaFile instanceof File) {
        formData.append('media', storyData.mediaFile)
        formData.append('mediaType', storyData.mediaType)
        console.log('📎 Appending media:', storyData.mediaFile.name, 'Type:', storyData.mediaType)
      }

      const response = await fetch(`${HTTP_URL}/api/stories`, {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const result = await response.json()

      if (result.success && result.story) {
        console.log('✅ Story created via Backend:', result.story.id)
        return result.story
      } else {
        console.error('❌ Server returned invalid story:', result)
        throw new Error('Server returned invalid story object')
      }
    } catch (error) {
      console.error('❌ createStory error:', error)
      throw error
    }
  }

  async getStories(limit = 50) {
    try {
      const response = await fetch(`${HTTP_URL}/api/stories?limit=${limit}`)
      const result = await response.json()
      
      if (result.success) {
        return result.stories
      }
      return []
    } catch (error) {
      console.error('❌ Error fetching stories:', error)
      return []
    }
  }

  async deleteStory(storyId, userId) {
    // Send via WebSocket
    this.send({
      type: 'DELETE_STORY',
      payload: { storyId, userId }
    })

    // Fallback: HTTP
    try {
      const response = await fetch(`${HTTP_URL}/api/stories/${storyId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      })

      const result = await response.json()

      if (result.success) {
        return true
      }
    } catch (error) {
      console.error('❌ HTTP fallback failed:', error)
    }

    return false
  }

  async getNotifications(userId, unreadOnly = false) {
    try {
      const response = await fetch(`${HTTP_URL}/api/notifications/${userId}?unreadOnly=${unreadOnly}`)
      const result = await response.json()
      
      if (result.success) {
        return result.notifications
      }
      return []
    } catch (error) {
      console.error('❌ Error fetching notifications:', error)
      return []
    }
  }

  // ============================================
  // User Management
  // ============================================

  // Combined setup: set all user data then authenticate ONCE
  setupUser(userId, username, avatar) {
    this.userId = userId
    this.username = username
    this.avatar = avatar
    if (this.connected) {
      this.authenticate()
    }
  }

  // Keep for backward compatibility but don't auto-auth
  setUserId(userId) {
    this.userId = userId
  }

  // ============================================
  // Cleanup
  // ============================================

  disconnect() {
    this.stopHeartbeat()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
  }
}

// Export singleton instance
export const websocketService = new WebSocketService()

export default websocketService
