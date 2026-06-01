<template>
  <div class="create-post">
    <div class="post-input-container">
      <div class="input-header">
        <div class="user-avatar">
          <img v-if="postsStore.currentUserAvatar && postsStore.currentUserAvatar.length > 5" :src="postsStore.currentUserAvatar" class="avatar-img" />
          <span v-else class="avatar-placeholder">👤</span>
        </div>
        <!-- وصف المنشور -->
        <textarea
          v-model="postContent"
          placeholder="بم تفكر؟ (اكتب شيئاً...)"
          rows="3"
          :disabled="isPosting"
        ></textarea>
      </div>

      <!-- معاينة الصورة -->
      <div v-if="selectedImage" class="image-preview-container">
        <div class="image-preview">
          <img :src="imageUrl" alt="معاينة الصورة" />
          <button
            @click="removeImage"
            class="remove-media-btn"
            :disabled="isPosting"
            title="إزالة الصورة"
          >
            ×
          </button>
        </div>
      </div>

      <!-- معاينة الفيديو -->
      <div v-else-if="selectedVideo" class="video-preview-container">
        <!-- شريط التقدم أثناء المعالجة -->
        <div v-if="videoProcessing" class="video-processing">
          <div class="processing-spinner"></div>
          <p>جاري معالجة الفيديو...</p>
          <div v-if="videoProcessingProgress > 0" class="progress-bar">
            <div class="progress-fill" :style="{ width: videoProcessingProgress + '%' }"></div>
          </div>
          <small>{{ videoProcessingProgress.toFixed(0) }}%</small>
        </div>

        <div v-else class="video-preview">
          <video
            ref="videoPreview"
            :src="videoUrl"
            controls
            @loadedmetadata="onVideoLoaded"
          ></video>
          <button
            class="remove-media-btn"
            @click="removeVideo"
            :disabled="isPosting"
            title="إزالة الفيديو"
          >
            ×
          </button>
        </div>

        <!-- معلومات الفيديو -->
        <div v-if="videoMetadata" class="media-info">
          <span class="media-duration">⏱️ {{ formatDuration(videoMetadata.duration) }}</span>
          <span class="media-size">📦 {{ formatFileSize(videoMetadata.size) }}</span>
          <span class="media-name">{{ videoMetadata.name }}</span>
          <span v-if="videoMetadata.warning" class="media-warning" :title="videoMetadata.warning">
            ⚠️
          </span>
        </div>
        
        <!-- تحذير الفيديو -->
        <div v-if="videoMetadata?.warning" class="video-warning-banner">
          <span class="warning-icon">⚠️</span>
          <span class="warning-text">{{ videoMetadata.warning }}</span>
        </div>
      </div>

      <!-- أزرار الإجراءات -->
      <div class="post-actions">
        <div class="action-buttons">
          <!-- زر الصور -->
          <button
            @click="triggerImageUpload"
            class="action-btn image-btn"
            title="إضافة صورة"
            :disabled="isPosting || selectedImage || selectedVideo || videoProcessing"
          >
            <span class="btn-icon">📸</span>
            <span class="btn-text">صورة</span>
          </button>
          <input
            ref="imageInput"
            type="file"
            accept="image/*"
            :disabled="isPosting"
            @change="handleImageSelect"
            style="display: none"
          />

          <!-- زر الفيديو -->
          <button
            @click="triggerVideoUpload"
            class="action-btn video-btn"
            title="إضافة فيديو"
            :disabled="isPosting || selectedImage || selectedVideo || videoProcessing"
          >
            <span class="btn-icon">🎬</span>
            <span class="btn-text">فيديو</span>
          </button>
          <input
            ref="videoInput"
            type="file"
            accept="video/*"
            :disabled="isPosting"
            @change="handleVideoSelect"
            style="display: none"
          />
        </div>

        <div class="publish-actions">
          <button
            v-if="selectedImage || selectedVideo"
            @click="cancelPost"
            class="cancel-btn"
            :disabled="isPosting || videoProcessing"
          >
            إلغاء
          </button>
          <button
            @click="publishPost"
            :disabled="!canPublish || isPosting || videoProcessing"
            class="publish-btn"
          >
            <span v-if="isPosting" class="spinner-small"></span>
            <span v-else>نشر</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { usePostsStore } from '../stores/postsStore'
import { localPostService } from '../services/localPostService'
import {
  validateVideoFile,
  processVideoFile,
  getVideoMetadata,
  formatFileSize,
  formatDuration
} from '../services/videoProcessingService'
import { deleteVideo } from '../services/videoStorageService'

const postsStore = usePostsStore()

const postContent = ref('')
const selectedImage = ref(null)
const selectedVideo = ref(null)
const imageUrl = ref(null)
const videoUrl = ref(null)
const imageInput = ref(null)
const videoInput = ref(null)
const videoPreview = ref(null)
const imageFile = ref(null)
const videoFile = ref(null)
const videoId = ref(null)
const videoMetadata = ref(null)
const videoProcessing = ref(false)
const videoProcessingProgress = ref(0)
const isPosting = ref(false)

const canPublish = computed(() => {
  const hasContent = postContent.value.trim().length > 0
  const hasMedia = !!selectedImage.value || !!selectedVideo.value
  return (hasContent || hasMedia) && !videoProcessing.value
})

function onVideoLoaded(event) {
  if (videoMetadata.value) {
    videoMetadata.value.duration = event.target.duration
  }
}

function triggerImageUpload() {
  imageInput.value?.click()
}

function triggerVideoUpload() {
  videoInput.value?.click()
}

function handleImageSelect(event) {
  const file = event.target.files[0]
  if (file && file.type.startsWith('image/')) {
    imageFile.value = file

    if (imageUrl.value) {
      URL.revokeObjectURL(imageUrl.value)
    }

    const reader = new FileReader()
    reader.onload = e => {
      imageUrl.value = e.target.result
      selectedImage.value = imageUrl.value
    }
    reader.readAsDataURL(file)
  }
}

async function handleVideoSelect(event) {
  const file = event.target.files[0]
  if (!file) return

  console.log('🎬 Video file selected:', file.name)
  console.log('   Size:', (file.size / 1024 / 1024).toFixed(2), 'MB')
  console.log('   Type:', file.type)

  // Validate video file - NOW ACCEPTS ALL VIDEO TYPES AND SIZES
  const validation = validateVideoFile(file)
  if (!validation.valid) {
    alert('❌ ' + validation.error)
    if (videoInput.value) {
      videoInput.value.value = ''
    }
    return
  }

  console.log('✅ Video validation passed')
  console.log('   Format:', validation.format.name)
  console.log('   Size:', validation.sizeMB, 'MB')
  
  // Show warning if file is very large
  if (validation.sizeMB > 500) {
    const confirmed = confirm(
      `⚠️ تحذير: حجم الفيديو كبير جداً (${validation.sizeMB}MB)\n\n` +
      `سيتم معالجة الفيديو ولكن قد يستغرق وقتاً طويلاً.\n` +
      `هل تريد المتابعة؟`
    )
    if (!confirmed) {
      if (videoInput.value) {
        videoInput.value.value = ''
      }
      return
    }
  }

  videoProcessing.value = true
  videoProcessingProgress.value = 0

  try {
    const backendMode = import.meta.env.VITE_BACKEND_MODE || 'local'

    // Get video metadata
    const metadata = await getVideoMetadata(file)
    console.log('📊 Video metadata:', metadata)

    // Process video file with enhanced options
    const result = await processVideoFile(file, {
      onProgress: progress => {
        videoProcessingProgress.value = progress
      },
      useIndexedDB: backendMode === 'local',
      maxSizeForBase64: 10 * 1024 * 1024, // 10MB
      maxSizeForIndexedDB: 500 * 1024 * 1024 // 500MB
    })

    console.log('✅ Video processed successfully')
    console.log('   Storage:', result.storage)
    console.log('   Video ID:', result.videoId)
    console.log('   Blob URL:', result.blobUrl ? '✅ exists' : '❌ missing')
    console.log('   URL:', result.url ? '✅ exists' : '❌ missing')

    videoFile.value = file
    // Use the persistent URL (base64 or IndexedDB), not the temporary blobUrl
    videoUrl.value = result.url || result.blobUrl
    selectedVideo.value = result.storage
    videoId.value = result.videoId || null

    videoMetadata.value = {
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      size: file.size,
      type: file.type,
      name: file.name,
      storage: result.storage,
      warning: result.warning,
      // For IndexedDB videos (< 500MB): store null, will load from IndexedDB via videoId
      // For blob videos (> 500MB): store blobUrl (temporary, lost on page reload)
      blobUrl: result.storage === 'indexeddb'
        ? null  // Will load from IndexedDB using videoId
        : result.blobUrl  // Blob URL - temporary
    }

    videoProcessing.value = false
    videoProcessingProgress.value = 100

    const sizeText = validation.sizeMB >= 1000
      ? `${(validation.sizeMB / 1024).toFixed(1)}GB`
      : `${validation.sizeMB}MB`
    showToast(`✅ تم تحميل الفيديو بنجاح! (${sizeText})`, 'success')
  } catch (error) {
    console.error('❌ Error processing video:', error)
    videoProcessing.value = false
    videoProcessingProgress.value = 0

    let errorMsg = 'فشل معالجة الفيديو:\n\n' + error.message
    
    if (error.message.includes('QuotaExceeded') || error.message.includes('quota')) {
      errorMsg = '❌ مساحة التخزين ممتلئة!\n\n' +
                 'يمكنك:\n' +
                 '1. حذف بعض المنشورات القديمة\n' +
                 '2. استخدام فيديو أصغر حجماً'
    }

    alert(errorMsg)

    if (videoInput.value) {
      videoInput.value.value = ''
    }
  }
}

function removeImage() {
  if (imageUrl.value) {
    URL.revokeObjectURL(imageUrl.value)
  }
  selectedImage.value = null
  imageUrl.value = null
  imageFile.value = null
  if (imageInput.value) {
    imageInput.value.value = ''
  }
}

async function removeVideo() {
  if (videoUrl.value && videoUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(videoUrl.value)
  }

  if (videoId.value) {
    try {
      await deleteVideo(videoId.value)
      console.log('🗑️ Video deleted from IndexedDB')
    } catch (err) {
      console.error('Failed to delete video from IndexedDB:', err)
    }
  }

  selectedVideo.value = null
  videoUrl.value = null
  videoFile.value = null
  videoId.value = null
  videoMetadata.value = null
  videoProcessing.value = false
  videoProcessingProgress.value = 0

  if (videoInput.value) {
    videoInput.value.value = ''
  }
}

function cancelPost() {
  removeImage()
  removeVideo()
  postContent.value = ''
}

async function publishPost() {
  if (!canPublish.value || isPosting.value) return

  isPosting.value = true

  try {
    if (!postContent.value.trim() && !selectedImage.value && !selectedVideo.value) {
      throw new Error('يرجى إضافة محتوى أو صورة أو فيديو')
    }

    console.log('\n📝 Publishing post...')
    console.log('   Content:', postContent.value.trim().substring(0, 30))
    console.log('   Image File:', imageFile.value?.name || 'none')
    console.log('   Video File:', videoFile.value?.name || 'none')

    // Clean up old posts before creating new one (prevent quota errors)
    localPostService.clearOldPosts(10)

    // Use postsStore.addPost() which handles both backend and localStorage
    const newPost = await postsStore.addPost({
      content: postContent.value.trim(),
      imageFile: imageFile.value,
      videoFile: videoFile.value,
      videoId: videoId.value,
      duration: videoMetadata.value?.duration || 0
    })

    if (newPost) {
      showToast('تم النشر بنجاح! 🎉', 'success')
    } else {
      throw new Error('فشل النشر')
    }

    // Clear form
    removeImage()
    removeVideo()
    postContent.value = ''
  } catch (error) {
    console.error('❌ Error publishing post:', error)

    // Detect specific error types for better user messaging
    const isNetworkError = error.message?.includes('Failed to fetch') ||
                           error.message?.includes('NetworkError') ||
                           error.message?.includes('CORS') ||
                           error.message?.includes('Network request failed')

    const isQuotaError = error.message?.includes('QuotaExceeded') ||
                         error.message?.includes('حد')

    let errorMessage
    if (isQuotaError) {
      errorMessage = 'مساحة التخزين ممتلئة. تم تنظيف المنشورات القديمة.'
    } else if (isNetworkError) {
      // Mobile-specific: provide helpful message about connection
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      errorMessage = isMobile
        ? 'فشل الاتصال بالخادم. تأكد من اتصالك بالإنترنت وأن السيرفر يعمل على جهاز الكمبيوتر.'
        : 'فشل الاتصال. تأكد من تشغيل السيرفر.'
    } else {
      errorMessage = error.message || 'فشل النشر. حاول مرة أخرى.'
    }

    showToast(errorMessage, 'error')
  } finally {
    isPosting.value = false
  }
}

function showToast(message, type = 'success') {
  // SECURITY FIX: Sanitize message to prevent XSS attacks
  const sanitizedMessage = String(message)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
  
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  toast.textContent = sanitizedMessage // Use textContent instead of innerHTML for safety
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${type === 'success' ? '#42b72a' : '#e41e3f'};
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    font-weight: 500;
    z-index: 10000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: slideInRight 0.3s ease;
    max-width: 300px;
    word-break: break-word;
  `
  document.body.appendChild(toast)

  setTimeout(() => {
    toast.style.animation = 'slideOutRight 0.3s ease'
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}

onBeforeUnmount(() => {
  if (imageUrl.value) {
    URL.revokeObjectURL(imageUrl.value)
  }
  if (videoUrl.value && videoUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(videoUrl.value)
  }
})
</script>

<style scoped>
.create-post {
  background: white;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  padding: 1rem;
  margin-bottom: 1rem;
}

.post-input-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.post-input-container textarea {
  flex: 1;
  border: none;
  resize: none;
  font-size: 1.1rem;
  font-family: inherit;
  padding: 0.75rem;
  outline: none;
  background-color: #f0f2f5;
  border-radius: 20px;
  min-height: 44px;
  transition: all 0.2s;
}

.input-header {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.user-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: #f0f2f5;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(0,0,0,0.05);
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-placeholder {
  font-size: 1.5rem;
}

.post-input-container textarea:disabled {
  background-color: #e4e6eb;
  cursor: not-allowed;
}

.post-input-container textarea::placeholder {
  color: #65676b;
}

.image-preview-container,
.video-preview-container {
  position: relative;
  margin-top: 0.5rem;
}

.image-preview,
.video-preview {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.image-preview {
  background: #f0f2f5;
}

.video-preview {
  background: #000;
}

.image-preview img,
.video-preview video {
  width: 100%;
  display: block;
  max-height: 500px;
  object-fit: contain;
}

.video-processing {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 12px;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  color: white;
}

.processing-spinner {
  width: 50px;
  height: 50px;
  border: 4px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.progress-bar {
  width: 100%;
  height: 8px;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: white;
  transition: width 0.3s ease;
}

.remove-media-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  background: rgba(228, 30, 63, 0.9);
  color: white;
  border: none;
  border-radius: 50%;
  width: 40px;
  height: 40px;
  cursor: pointer;
  font-size: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  transition: all 0.2s;
}

.remove-media-btn:hover:not(:disabled) {
  background: rgba(228, 30, 63, 1);
  transform: scale(1.1);
}

.remove-media-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.media-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem;
  background: #f0f2f5;
  border-radius: 8px;
  margin-top: 0.5rem;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.media-duration,
.media-size {
  font-size: 0.85rem;
  color: #65676b;
  font-weight: 500;
  white-space: nowrap;
}

.media-name {
  font-size: 0.85rem;
  color: #050505;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 100px;
}

.media-warning {
  font-size: 1.2rem;
  cursor: help;
  animation: pulse 2s ease-in-out infinite;
}

.video-warning-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%);
  border: 1px solid #ffc107;
  border-radius: 8px;
  margin-top: 0.5rem;
  color: #856404;
  font-size: 0.85rem;
  font-weight: 500;
  animation: slideDown 0.3s ease;
}

.video-warning-banner .warning-icon {
  font-size: 1.2rem;
}

.video-warning-banner .warning-text {
  flex: 1;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

@keyframes slideDown {
  from {
    transform: translateY(-10px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.post-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 0.75rem;
  border-top: 1px solid #e4e6eb;
  gap: 1rem;
}

.action-buttons {
  display: flex;
  gap: 0.5rem;
}

.action-btn {
  padding: 0.6rem 1.25rem;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.image-btn {
  background-color: #e7f7ed;
  color: #28a745;
}

.image-btn:hover:not(:disabled) {
  background-color: #d4f0dd;
}

.video-btn {
  background-color: #f0e7ff;
  color: #8b5cf6;
}

.video-btn:hover:not(:disabled) {
  background-color: #e7d0ff;
}

.publish-actions {
  display: flex;
  gap: 0.5rem;
}

.cancel-btn {
  background-color: #e4e6eb;
  color: #050505;
  border: none;
  padding: 0.6rem 1.5rem;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.2s;
}

.cancel-btn:hover:not(:disabled) {
  background-color: #d8dadf;
}

.publish-btn {
  background-color: #1877f2;
  color: white;
  border: none;
  padding: 0.6rem 2rem;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.publish-btn:hover:not(:disabled) {
  background-color: #166fe5;
  transform: translateY(-1px);
}

.publish-btn:disabled {
  background-color: #e4e6eb;
  color: #bcc0c4;
  cursor: not-allowed;
  transform: none;
}

.spinner-small {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes slideInRight {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slideOutRight {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(100%);
    opacity: 0;
  }
}

/* ==========================================
   ✅ Cross-Platform Responsive Styles
   ========================================== */

/* Tablet */
@media screen and (max-width: 768px) {
  .create-post-card {
    width: min(100%, 95vw);
  }
}

/* Mobile */
@media screen and (max-width: 480px) {
  .create-post-card {
    padding: 12px;
  }

  .create-post-header {
    padding: 10px 0;
  }

  .create-post-textarea {
    font-size: 14px;
  }

  .create-post-actions {
    flex-wrap: wrap;
    gap: 6px;
  }

  .create-post-actions button {
    flex: 1 1 calc(50% - 3px);
    min-height: 44px;
  }
}

/* Small mobile */
@media screen and (max-width: 360px) {
  .create-post-card {
    padding: 8px;
  }

  .create-post-actions button {
    flex: 1 1 100%;
  }
}

/* ==========================================
   ✅ Dark Mode Support - Romantic Theme
   ========================================== */
[data-theme="dark"] .create-post {
  background: var(--bg-card);
  box-shadow: 0 2px 12px var(--shadow);
}

[data-theme="dark"] .post-input-container textarea {
  background-color: var(--bg-secondary);
  color: var(--text-primary);
}

[data-theme="dark"] .post-input-container textarea::placeholder {
  color: var(--text-secondary);
}

[data-theme="dark"] .post-input-container textarea:disabled {
  background-color: var(--hover-bg);
}

[data-theme="dark"] .media-info {
  background: var(--bg-secondary);
}

[data-theme="dark"] .media-name {
  color: var(--text-primary);
}

[data-theme="dark"] .media-duration,
[data-theme="dark"] .media-size {
  color: var(--text-secondary);
}

[data-theme="dark"] .post-actions {
  border-color: var(--border-color);
}

[data-theme="dark"] .cancel-btn {
  background-color: var(--bg-secondary);
  color: var(--text-primary);
}

[data-theme="dark"] .cancel-btn:hover:not(:disabled) {
  background-color: var(--hover-bg);
}

[data-theme="dark"] .publish-btn {
  background: var(--gradient-romantic);
  border: none;
}

[data-theme="dark"] .publish-btn:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

[data-theme="dark"] .publish-btn:disabled {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
</style>
