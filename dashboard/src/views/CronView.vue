<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { refreshState, formatDateTime } from '../store'
import type { CronTaskRecord } from '@shared/types'
import LiveTimeAgo from '../components/LiveTimeAgo.vue'

const items = ref<CronTaskRecord[]>([])
const total = ref(0)
const loading = ref(false)
const filter = ref('')
const now = ref(Date.now())
let nowIntervalId: ReturnType<typeof setInterval> | null = null

function debounce(fn: Function, delay: number) {
  let timeout: ReturnType<typeof setTimeout>
  return (...args: any[]) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), delay)
  }
}

const route = useRoute()
const router = useRouter()
const debouncedLoad = debounce(loadData, 500)

const pagination = ref({ page: 0, limit: 20 })

function updateUrlFromFilter() {
  const query: Record<string, string> = {}
  if (filter.value) query.filter = filter.value
  // Only update if different to avoid loop
  if ((filter.value || '') !== (route.query.filter || '')) {
    router.replace({ query })
  }
}

watch(() => route.query.filter, (newFilter) => {
  filter.value = (newFilter as string) || ''
  pagination.value.page = 0
  loadData()
}, { immediate: true })

const paginationInfo = computed(() => {
  if (total.value === 0) return 'Showing 0-0 of 0'
  const start = pagination.value.page * pagination.value.limit + 1
  const end = Math.min((pagination.value.page + 1) * pagination.value.limit, total.value)
  return `Showing ${start}-${end} of ${total.value}`
})
const maxPage = computed(() => Math.ceil(total.value / pagination.value.limit) - 1)

async function loadData() {
  loading.value = true
  try {
    const res = await api.cron.list({
      limit: pagination.value.limit,
      skip: pagination.value.page * pagination.value.limit,
      filter: filter.value || undefined
    })
    items.value = res.items
    total.value = res.total
    // Update URL to reflect current filter
    updateUrlFromFilter()
  } catch (err) {
    console.error(err)
    alert('Failed to load cron tasks')
  } finally {
    loading.value = false
  }
}

async function triggerTask(id: string) {
  try {
    loading.value = true
    await api.cron.trigger({ taskId: id })
    await loadData() // Refresh status
  } catch (err) {
    console.error(err)
    alert('Failed to trigger task')
  } finally {
    loading.value = false
  }
}

function getStatusClass(item: CronTaskRecord) {
  if (item.status === 'locked' || item.status === 'running') return 'status-processing'
  if (item.status === 'failed') return 'status-failed'
  return 'status-pending'
}

function isOverdue(nextRunAt: string | Date) {
  return new Date(nextRunAt).getTime() <= now.value
}

function getCountdownProgress(nextRunAt: string | Date) {
  const nextRunMs = new Date(nextRunAt).getTime()
  const timeLeft = nextRunMs - now.value
  if (timeLeft <= 0) return 100 // Overdue
  if (timeLeft >= 10000) return 0 // More than 10s away
  return ((10000 - timeLeft) / 10000) * 100 // 0-100% in last 10 seconds
}

function prevPage() {
  if (pagination.value.page > 0) {
    pagination.value.page--
    loadData()
  }
}

function nextPage() {
  if (pagination.value.page < maxPage.value) {
    pagination.value.page++
    loadData()
  }
}

watch(() => refreshState.trigger.value, () => {
    loadData()
})

onMounted(() => {
  loadData()
  nowIntervalId = setInterval(() => { now.value = Date.now() }, 100)
})

onUnmounted(() => {
  if (nowIntervalId) clearInterval(nowIntervalId)
})
</script>

<template>
  <div class="card">
    <!-- Toolbar Removed -->

    <div class="table-responsive">
      <table>
        <thead>
          <tr>
            <th style="min-width: 140px; padding: 8px 4px;">
              Task ID
              <div style="margin-top: 4px" class="filter-input-wrapper">
                 <input type="text" v-model="filter" placeholder="Search ID..." class="filter-input" @input="debouncedLoad">
                 <button v-if="filter" class="filter-clear-btn" @click="filter = ''; loadData()" title="Clear">&times;</button>
              </div>
            </th>
            <th style="min-width: 100px;">Status</th>
            <th style="white-space: nowrap">Next Run</th>
            <th style="min-width: 180px;">Last Run Status</th>
            <th style="text-align: left; min-width: 100px;">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="items.length === 0">
            <td colspan="5" style="text-align: center; color: var(--text-secondary);">No tasks found</td>
          </tr>
          <tr v-for="item in items" :key="item._id">
            <td>
              <strong>{{ item._id }}</strong>
              <span v-if="!item.isRegistered" title="Not registered on this instance"> ⚠️</span>
            </td>
            <td>
              <span class="status-badge" :class="getStatusClass(item)">{{ item.status }}</span>
            </td>
            <td class="next-run-cell">
              <div v-if="isOverdue(item.nextRunAt)" class="overdue-text">Should run already</div>
              <div v-else>{{ formatDateTime(item.nextRunAt) }} <small class="text-secondary">{{ refreshState.timezoneSuffix.value }}</small></div>
              <small v-if="!isOverdue(item.nextRunAt)" class="text-secondary"><LiveTimeAgo :date="item.nextRunAt" /></small>
              <div class="next-run-progress" v-if="getCountdownProgress(item.nextRunAt) > 0">
                <div class="next-run-progress-bar" :style="{ width: getCountdownProgress(item.nextRunAt) + '%' }"></div>
              </div>
            </td>
            <td>
              <div v-if="item.lastRun" style="font-size:12px">
                <div v-if="item.lastRun.error" class="error-text" :title="item.lastRun.error">
                  Failed at {{ formatDateTime(item.lastRun.finishedAt || item.lastRun.startedAt) }} <small class="text-secondary">{{ refreshState.timezoneSuffix.value }}</small>
                  <div class="text-secondary"><LiveTimeAgo :date="item.lastRun.finishedAt || item.lastRun.startedAt" /></div>
                </div>
                <div v-else>
                  Success: {{ formatDateTime(item.lastRun.finishedAt || item.lastRun.startedAt) }} <small class="text-secondary">{{ refreshState.timezoneSuffix.value }}</small>
                  <div class="text-secondary"><LiveTimeAgo :date="item.lastRun.finishedAt || item.lastRun.startedAt" /></div>
                  <div class="text-secondary text-xs">Duration: {{ item.lastRun.durationMs }}ms</div>
                </div>
              </div>
              <span v-else class="text-secondary">Never run</span>
            </td>
            <td>
              <button class="btn btn-secondary" @click="triggerTask(item._id)" :disabled="item.status === 'running' || item.status === 'locked'">Run Now</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pagination">
      <span>{{ paginationInfo }}</span>
      <div style="display:flex; gap: 8px;">
        <button class="btn btn-secondary" @click="prevPage" :disabled="pagination.page === 0 || loading">Previous</button>
        <button class="btn btn-secondary" @click="nextPage" :disabled="pagination.page >= maxPage || loading">Next</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.text-secondary { color: var(--text-secondary); }

.next-run-cell {
  position: relative;
}

.overdue-text {
  color: var(--warning-color);
  font-weight: 500;
}

.next-run-progress {
  height: 2px;
  background: transparent;
  margin-top: 4px;
}

.next-run-progress-bar {
  height: 100%;
  background: #d1d5db; /* Light gray */
  transition: width 0.1s linear;
}

.table-responsive {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
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
