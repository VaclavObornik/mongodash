<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { refreshState, formatDateTime } from '../store'
import type { ReactiveTaskRecord } from '@shared/types'
import LiveTimeAgo from '../components/LiveTimeAgo.vue'

// Use 'any' or default generic to avoid strict Document type issues in frontend
const items = ref<ReactiveTaskRecord[]>([])
const total = ref(0)
const loading = ref(false)
const flash = ref(false)
const stats = ref<import('@shared/types').FacetStats>({ statuses: [], errorCount: 0 })


const route = useRoute()
const router = useRouter()

const filters = reactive({
  task: '',
  collection: '',
  statuses: [] as string[],
  errorMessage: '',
  hasError: false,
  sourceDocId: ''
})

const pagination = reactive({
  page: 0,
  limit: 20
})

const statusOptions = ['pending', 'processing', 'completed', 'failed']

const hasActiveFilters = computed<boolean>(() => {
  return !!(filters.task || filters.collection || filters.statuses.length > 0 || filters.errorMessage || filters.hasError || filters.sourceDocId)
})

const paginationInfo = computed(() => {
  if (total.value === 0) return 'Showing 0-0 of 0'
  const start = pagination.page * pagination.limit + 1
  const end = Math.min((pagination.page + 1) * pagination.limit, total.value)
  return `Showing ${start}-${end} of ${total.value}`
})

const maxPage = computed(() => Math.ceil(total.value / pagination.limit) - 1)

// Initialize filters from URL query params
function initFiltersFromUrl() {
  filters.task = (route.query.task as string) || ''
  filters.collection = (route.query.collection as string) || ''
  filters.statuses = route.query.status ? (route.query.status as string).split(',') : []
  filters.sourceDocId = (route.query.sourceDocId as string) || ''
  filters.errorMessage = (route.query.errorMessage as string) || ''
  filters.hasError = route.query.hasError === 'true'
}

// Update URL when filters change
function updateUrlFromFilters() {
  const query: Record<string, string> = {}
  if (filters.task) query.task = filters.task
  if (filters.collection) query.collection = filters.collection
  if (filters.statuses.length > 0) query.status = filters.statuses.join(',')
  if (filters.sourceDocId) query.sourceDocId = filters.sourceDocId
  if (filters.errorMessage) query.errorMessage = filters.errorMessage
  if (filters.hasError) query.hasError = 'true'
  // Only update if different to avoid loop
  const currentQuery = route.query
  const needsUpdate =
    query.task !== (currentQuery.task || '') ||
    query.collection !== (currentQuery.collection || '') ||
    query.status !== (currentQuery.status || '') ||
    query.sourceDocId !== (currentQuery.sourceDocId || '') ||
    query.errorMessage !== (currentQuery.errorMessage || '') ||
    (query.hasError || '') !== (currentQuery.hasError || '')
  if (needsUpdate) {
    router.replace({ query })
  }
}

// Watch for route changes (e.g., sidebar navigation)
watch(() => route.query, () => {
  initFiltersFromUrl()
  pagination.page = 0
  loadData()
}, { immediate: true })

async function loadData() {
  loading.value = true
  try {
    const res = await api.reactive.list({
      limit: pagination.limit,
      skip: pagination.page * pagination.limit,
      task: filters.task || undefined,
      collection: filters.collection || undefined,
      status: filters.statuses.length > 0 ? filters.statuses.join(',') : undefined,
      errorMessage: filters.errorMessage || undefined,
      hasError: filters.hasError ? 'true' : undefined,
      sourceDocId: filters.sourceDocId || undefined
    })
    items.value = res.items
    total.value = res.total
    if (res.stats) {
       stats.value = res.stats
    }
    // Update URL to reflect current filters
    updateUrlFromFilters()

  } catch (err) {
    console.error(err)
    alert('Failed to load tasks')
  } finally {
    loading.value = false
    flash.value = true
    setTimeout(() => {
      flash.value = false
    }, 600)
  }
}

function copyToClipboard(text: string, event: Event) {
  const btn = (event.currentTarget as HTMLElement)
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied')
    setTimeout(() => btn.classList.remove('copied'), 1500)
  }).catch(err => {
    console.error('Failed to copy:', err)
  })
}

const showRetryModal = ref(false)

function openRetryModal() {
  if (!hasActiveFilters.value) return
  showRetryModal.value = true
}

async function confirmRetryTasks() {
  showRetryModal.value = false
  try {
    const res = await api.reactive.retry({
      task: filters.task || undefined,
      status: filters.statuses.length > 0 ? filters.statuses.join(',') : undefined,
      errorMessage: filters.errorMessage || undefined,
      sourceDocId: filters.sourceDocId || undefined
    })
    alert(`Retry triggered for ${res.modifiedCount} tasks`)
    loadData()
  } catch (err) {
    console.error(err)
    alert('Failed to trigger retry')
  }
}

async function retrySingle(task: string, id: string) {
    try {
        await api.reactive.retry({ task, _id: id })
        loadData()
    } catch (err) {
        console.error('Retry failed:', err)
    }
}

function prevPage() {
  if (pagination.page > 0) {
    pagination.page--
    loadData()
  }
}

function nextPage() {
  if (pagination.page < maxPage.value) {
    pagination.page++
    loadData()
  }
}


function debounce(fn: Function, delay: number) {
  let timeout: ReturnType<typeof setTimeout>
  return (...args: any[]) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), delay)
  }
}

const debouncedLoad = debounce(loadData, 500)

watch(filters, () => {
  pagination.page = 0
  debouncedLoad()
})


watch(() => refreshState.trigger.value, () => {
    loadData()
})

function getStatusCount(status: string) {
  const s = stats.value.statuses.find(x => x._id === status)
  return s ? s.count : 0
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="card" style="position: relative; min-height: 400px;">
    <div v-if="loading" class="loading-overlay">
      <div class="loading-spinner"></div>
    </div>

    <!-- Toolbar -->
    <!-- Toolbar Removed -->

    <!-- Table -->
    <div class="table-responsive">
      <table>
        <thead>
          <tr>
            <th v-if="!filters.task" style="width: 100px;">Task Name</th>
            <th style="width: 120px;">
              Source Doc ID
              <div style="margin-top: 4px" class="filter-input-wrapper">
                 <input type="text" v-model="filters.sourceDocId" @input="debouncedLoad" placeholder="Search ID..." class="filter-input">
                 <button v-if="filters.sourceDocId" class="filter-clear-btn" @click="filters.sourceDocId = ''; loadData()" title="Clear">&times;</button>
              </div>
            </th>
            <th style="width: 200px">
               Status
               <div style="margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;">
                  <label v-for="status in statusOptions" :key="status" class="status-checkbox">
                    <input type="checkbox" :value="status" v-model="filters.statuses" @change="loadData">
                    <span class="status-badge" :class="'status-' + status" style="font-size: 11px; padding: 2px 6px;">{{ status }} <span style="opacity:0.8; font-size: 0.9em; margin-left: 2px;">{{ getStatusCount(status) }}</span></span>
                  </label>
               </div>
            </th>
            <th style="width: 130px;">Next Run</th>
            <th style="width: 220px">
              Last Run Status
              <div style="margin-top: 4px; display: flex; flex-direction: column; gap: 6px;">
                 <div class="filter-input-wrapper">
                   <input type="text" v-model="filters.errorMessage" placeholder="Filter error..." class="filter-input" @input="debouncedLoad">
                   <button v-if="filters.errorMessage" class="filter-clear-btn" @click="filters.errorMessage = ''; loadData()" title="Clear">&times;</button>
                 </div>
                 <label class="status-checkbox" style="display: flex; align-items: center; gap: 6px; margin: 0;">
                    <input type="checkbox" v-model="filters.hasError" @change="loadData">
                    <span class="status-badge status-warning" style="font-size: 11px; padding: 2px 8px; flex: 1; text-align: center;">has error ({{ stats.errorCount }})</span>
                  </label>
              </div>
            </th>
            <th style="width: 60px; text-align: center;">Attempts</th>
            <th style="text-align: left; width: 100px;">
               Actions
               <div style="margin-top: 4px; display: flex; justify-content: flex-start;">
                 <button class="btn btn-danger btn-action" @click="openRetryModal" :disabled="loading || !hasActiveFilters">
                   Retry Matching
                 </button>
               </div>
            </th>
          </tr>
        </thead>
        <tbody :class="{ 'flash-active': flash }">
          <tr v-if="items.length === 0">
            <td :colspan="filters.task ? 6 : 7" style="text-align: center; color: var(--text-secondary);">No tasks found</td>
          </tr>
          <tr v-for="item in items" :key="String(item._id)">
            <td v-if="!filters.task" style="word-break: break-all;">
              <strong>{{ item.task }}</strong><br>
              <small class="text-secondary">#{{ String(item._id).substring(0,8) }}...</small>
            </td>
            <td>
              <div style="display: inline-flex; align-items: center; gap: 2px;">
                <code>{{ item.sourceDocId }}</code>
                <button class="copy-btn" @click="copyToClipboard(String(item.sourceDocId), $event)" title="Copy ID">
                  <svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                  <svg class="check-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </button>
              </div>
            </td>
            <td>
              <span class="status-badge" :class="`status-${item.status}`">{{ item.status }}</span>
            </td>
            <td>
              <div style="font-size:12px">
                <div v-if="item.status === 'pending' || item.status === 'processing'">
                   <div>{{ item.nextRunAt ? formatDateTime(item.nextRunAt) : '-' }} <small class="text-secondary">{{ refreshState.timezoneSuffix.value }}</small></div>
                   <small class="text-secondary" v-if="item.nextRunAt"><LiveTimeAgo :date="item.nextRunAt" /></small>
                </div>
                <span v-else class="text-secondary">-</span>
              </div>
            </td>
            <td>
              <div style="font-size:12px">
                <div v-if="item.lastError" class="error-text" :title="String(item.lastError)">
                  Error {{ item.lastFinalizedAt ? 'at ' + formatDateTime(item.lastFinalizedAt) : '' }} <small class="text-secondary">{{ refreshState.timezoneSuffix.value }}</small>
                  <div v-if="item.lastFinalizedAt" class="text-secondary"><LiveTimeAgo :date="item.lastFinalizedAt" /></div>
                  <div>{{ item.lastError }}</div>
                </div>
                <div v-if="item.lastSuccess">
                  <span style="white-space: nowrap;">Last success: {{ formatDateTime(item.lastSuccess.at) }} <small class="text-secondary">{{ refreshState.timezoneSuffix.value }}</small></span>
                  <div class="text-secondary" style="display: flex; justify-content: space-between;"><LiveTimeAgo :date="item.lastSuccess.at" /><span class="text-xs" title="Duration">{{ item.lastSuccess.durationMs }}ms</span></div>
                </div>
                <div v-else-if="item.lastError" class="text-secondary">
                  No success yet
                </div>
                <div v-if="!item.lastSuccess && !item.lastError" class="text-secondary">
                   Never run
                </div>
              </div>
            </td>
            <td>{{ item.attempts }}</td>
            <td>
              <button class="btn btn-secondary btn-action" @click="retrySingle(item.task, String(item._id))">Retry now</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div class="pagination">
      <span>{{ paginationInfo }}</span>
      <div style="display:flex; gap: 8px;">
        <button class="btn btn-secondary" @click="prevPage" :disabled="pagination.page === 0 || loading">Previous</button>
        <button class="btn btn-secondary" @click="nextPage" :disabled="pagination.page >= maxPage || loading">Next</button>
      </div>
    </div>

    <!-- Retry Confirmation Modal -->
    <div v-if="showRetryModal" class="modal-overlay" @click.self="showRetryModal = false">
      <div class="modal">
        <div class="modal-header">
          <h3>Confirm Retry</h3>
          <button class="modal-close" @click="showRetryModal = false">&times;</button>
        </div>
        <div class="modal-body">
          <p>Are you sure you want to retry all tasks matching the current filter?</p>
          <div class="filter-summary" style="background: #f8fafc; padding: 12px; border-radius: 6px; margin-top: 12px; font-size: 13px; border: 1px solid #e2e8f0;">
             <div v-if="filters.task"><strong>Task:</strong> {{ filters.task }}</div>
             <div v-if="filters.collection"><strong>Collection:</strong> {{ filters.collection }}</div>
             <div v-if="filters.statuses.length"><strong>Statuses:</strong> {{ filters.statuses.join(', ') }}</div>
             <div v-if="filters.sourceDocId"><strong>Source IDs:</strong> {{ filters.sourceDocId }}</div>
             <div v-if="filters.errorMessage"><strong>Error Message:</strong> "{{ filters.errorMessage }}"</div>
             <div v-if="filters.hasError"><strong>Has Error:</strong> Yes</div>
          </div>
          <div class="modal-actions" style="display:flex; justify-content: flex-end; gap: 12px; margin-top: 20px;">
            <button class="btn btn-secondary" @click="showRetryModal = false">Cancel</button>
            <button class="btn btn-danger" @click="confirmRetryTasks">Retry now</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.text-secondary { color: var(--text-secondary); }

.status-filter {
  display: flex;
  gap: 8px;
  align-items: center;
}

.status-checkbox {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}

.status-checkbox input[type="checkbox"] {
  display: none;
}

.status-checkbox input[type="checkbox"]:checked + .status-badge {
  outline: 2px solid var(--primary-color);
  outline-offset: 1px;
}

.status-checkbox .status-badge {
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.status-checkbox input[type="checkbox"]:checked + .status-badge {
  opacity: 1;
}

.filter-separator {
  color: var(--border-color);
  font-weight: 300;
  margin: 0 4px;
}

tbody tr:hover {
  background-color: rgba(59, 130, 246, 0.04);
}

.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.6);
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(1px);
  border-radius: 8px;
}

.loading-spinner {
  width: 30px;
  height: 30px;
  border: 3px solid var(--border-color);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.flash-active {
  animation: flash-highlight 0.5s ease-out;
}

@keyframes flash-highlight {
  0% { background-color: rgba(59, 130, 246, 0.1); }
  100% { background-color: transparent; }
}

.table-responsive {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.copy-btn {
  background: none;
  border: none;
  padding: 2px;
  cursor: pointer;
  color: #9ca3af;
  vertical-align: middle;
  margin-left: 0;
}

.copy-btn:hover {
  color: #6b7280;
}

.copy-btn .check-icon {
  display: none;
}

.copy-btn.copied .copy-icon {
  display: none;
}

.copy-btn.copied .check-icon {
  display: inline;
  color: #16a34a;
}

.btn-action {
  padding: 4px 10px;
  font-size: 11px;
  min-width: 70px;
}

.filter-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.filter-input {
  width: 100%;
  box-sizing: border-box;
  font-weight: normal;
  padding: 4px 24px 4px 6px;
  font-size: 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
}

.filter-clear-btn {
  position: absolute;
  right: 4px;
  background: none;
  border: none;
  color: #9ca3af;
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.filter-clear-btn:hover {
  color: #6b7280;
}
</style>
