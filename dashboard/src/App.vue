<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { refreshState, setAutoRefresh, setTimezone, setLocale, fetchInfo } from './store'
import LiveTimeAgo from './components/LiveTimeAgo.vue'

function parseDate(d: Date | string | undefined): Date | null {
  if (!d) return null
  return typeof d === 'string' ? new Date(d) : d
}

const progressPercent = ref(0)
let progressIntervalId: ReturnType<typeof setInterval> | null = null
const showSettings = ref(false)

function updateProgress() {
  if (!refreshState.autoRefresh.value) {
    progressPercent.value = 0
    return
  }
  const lastRefreshTime = refreshState.lastRefresh.value.getTime()
  const intervalMs = refreshState.intervalSeconds.value * 1000
  const elapsed = Date.now() - lastRefreshTime
  progressPercent.value = Math.min(100, (elapsed / intervalMs) * 100)
}

function startProgressTimer() {
  if (progressIntervalId) clearInterval(progressIntervalId)
  progressIntervalId = setInterval(updateProgress, 100) // Update every 100ms for smooth animation
}

const autoRefreshValue = computed(() => refreshState.autoRefresh.value ? refreshState.intervalSeconds.value : 0)

function handleAutoRefreshChange(e: Event) {
  const value = Number((e.target as HTMLSelectElement).value)
  setAutoRefresh(value)
}

function handleTimezoneChange(e: Event) {
  const value = (e.target as HTMLSelectElement).value as 'local' | 'utc'
  setTimezone(value)
}

function handleLocaleChange(e: Event) {
  const value = (e.target as HTMLSelectElement).value
  setLocale(value)
}

onMounted(() => {
  fetchInfo()
  startProgressTimer()
})

onUnmounted(() => {
  if (progressIntervalId) clearInterval(progressIntervalId)
})

// Tabs configuration (Legacy - replaced by sidebar)
// const tabs = [
//   { name: 'reactive', label: 'Reactive Tasks', path: '/reactive' },
//   { name: 'cron', label: 'Cron Tasks', path: '/cron' },
// ]

const reactiveTasksByCollection = computed(() => {
  const groups: Record<string, typeof refreshState.reactiveTasks.value> = {}
  refreshState.reactiveTasks.value.forEach(t => {
    if (!groups[t.collection]) groups[t.collection] = []
    groups[t.collection].push(t)
  })
  return groups
})

const route = useRoute()
</script>

<template>
  <div class="container">
    <header>
      <div class="header-row">
        <div class="header-title">
          <!-- Logo removed as per user request -->
          <h1>
            Task Management
            <span v-if="refreshState.databaseName.value" class="title-separator">:</span>
            <span v-if="refreshState.databaseName.value" class="db-name">{{ refreshState.databaseName.value }}</span>
          </h1>
        </div>
        <div class="header-controls">
           <div class="auto-refresh-wrapper">
              <select :value="autoRefreshValue" @change="handleAutoRefreshChange" class="auto-refresh-select">
                 <option :value="0">Auto Refresh: Off</option>
                 <option :value="5">Auto Refresh: 5s</option>
                 <option :value="10">Auto Refresh: 10s</option>
                 <option :value="30">Auto Refresh: 30s</option>
                 <option :value="60">Auto Refresh: 1m</option>
              </select>
              <div v-if="refreshState.autoRefresh.value" class="refresh-progress">
                <div class="refresh-progress-bar" :style="{ width: progressPercent + '%' }"></div>
              </div>
           </div>
           <button class="settings-btn" @click="showSettings = true" title="Settings">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
           </button>
        </div>
      </div>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-section">
          <router-link
            to="/cron"
            class="sidebar-title-link"
            :class="{ active: route.path === '/cron' && Object.keys(route.query).length === 0 }"
          >
            Cron Tasks
          </router-link>
          <div class="sidebar-links">
            <router-link
              v-for="t in refreshState.cronTasks.value"
              :key="t.id"
              :to="{ path: '/cron', query: { filter: t.id } }"
              class="sidebar-link"
              :class="{
                active: route.path === '/cron' && route.query.filter === t.id,
                'status-failed': t.status === 'failed'
              }"
            >
              <span class="link-bullet">•</span>
              <span class="link-label">{{ t.id }}</span>
              <span v-if="t.status === 'failed'" class="status-badge error" title="Failed">!</span>
              <span v-else-if="t.status === 'running'" class="status-badge processing" title="Running">⋯</span>
              <small v-else-if="parseDate(t.nextRunAt)" class="cron-next-run"><LiveTimeAgo :date="parseDate(t.nextRunAt)!" /></small>
            </router-link>
          </div>
        </div>

        <div class="sidebar-section">
          <router-link
            to="/reactive"
            class="sidebar-title-link"
            :class="{ active: route.path === '/reactive' && Object.keys(route.query).length === 0 }"
          >
            Reactive Tasks
          </router-link>
          <div v-for="(tasks, collection) in reactiveTasksByCollection" :key="collection" class="collection-group">
            <router-link
              :to="{ path: '/reactive', query: { collection: collection } }"
              class="collection-title-link"
              :class="{ active: route.path === '/reactive' && route.query.collection === collection }"
            >
              {{ collection }}
            </router-link>
            <div class="sidebar-links">
              <router-link
                v-for="t in tasks"
                :key="t.name"
                :to="{ path: '/reactive', query: { task: t.name } }"
                class="sidebar-link"
                :class="{ active: route.path === '/reactive' && route.query.task === t.name }"
              >
                <span class="link-bullet">•</span>
                <span class="link-label">{{ t.name }}</span>
                <div class="sidebar-stats">
                  <span v-if="t.stats.pending > 0" class="stat-badge pending">{{ t.stats.pending }}</span>
                  <span v-if="t.stats.processing > 0" class="stat-badge processing">{{ t.stats.processing }}</span>
                  <span v-if="t.stats.success > 0" class="stat-badge success">{{ t.stats.success }}</span>
                  <span v-if="t.stats.failed > 0" class="stat-badge error">{{ t.stats.failed }}</span>
                  <span v-if="t.stats.error > 0" class="stat-pipe">|</span>
                  <span v-if="t.stats.error > 0" class="stat-badge warning">{{ t.stats.error }}</span>
                </div>
              </router-link>
            </div>
          </div>
        </div>
      </aside>

      <main class="main-content">
        <router-view v-slot="{ Component }">
          <keep-alive>
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </main>
    </div>

    <!-- Settings Modal -->
    <div v-if="showSettings" class="modal-overlay" @click.self="showSettings = false">
      <div class="modal">
        <div class="modal-header">
          <h3>Settings</h3>
          <button class="modal-close" @click="showSettings = false">&times;</button>
        </div>
        <div class="modal-body">
          <label class="setting-row">
            <span>Timezone</span>
            <select :value="refreshState.timezone.value" @change="handleTimezoneChange">
              <option value="local">Local Time</option>
              <option value="utc">UTC</option>
            </select>
          </label>
          <label class="setting-row">
            <span>Date/Time Format</span>
            <select :value="refreshState.locale.value" @change="handleLocaleChange">
              <option value="auto">Auto (System Default)</option>
              <option value="en-US">English (US) - MM/DD/YYYY, 12h</option>
              <option value="en-GB">English (UK) - DD/MM/YYYY, 24h</option>
              <option value="cs-CZ">Czech - D.M.YYYY, 24h</option>
              <option value="sv-SE">Swedish (ISO) - YYYY-MM-DD, 24h</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
:root {
  --bg-color: #f8fafc;
  --card-bg: #ffffff;
  --text-primary: #1e293b;
  --text-secondary: #64748b;
  --border-color: #e2e8f0;
  --primary-color: #3b82f6;
  --primary-hover: #2563eb;
  --success-color: #10b981;
  --warning-color: #f59e0b;
  --danger-color: #ef4444;
  --font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

body {
  font-family: var(--font-family);
  background-color: var(--bg-color);
  color: var(--text-primary);
  margin: 0;
  padding: 20px;
  line-height: 1.5;
}

.container {
  max-width: 1800px;
  margin: 0 auto;
}

.layout {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

.sidebar {
  width: 260px;
  min-width: 260px;
  position: sticky;
  top: 20px;
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  max-height: calc(100vh - 40px);
  overflow-y: auto;
}

.main-content {
  flex: 1;
  min-width: 0;
}

header { margin-bottom: 24px; }

.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  height: 32px;
  width: auto;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title-separator {
  margin: 0 8px;
  color: var(--text-secondary);
  font-weight: 400;
}

.db-name {
  color: var(--primary-color);
}

h1 {
  font-size: 24px;
  font-weight: 700;
  margin: 0;
}

.auto-refresh {
  font-size: 14px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 12px;
}

.auto-refresh-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
}

.interval-select {
    padding: 4px 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-size: 12px;
    min-width: auto !important; /* Override global min-width */
}

.auto-refresh-wrapper {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.auto-refresh-select {
    padding: 6px 12px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    font-size: 14px;
    color: var(--text-secondary);
    min-width: auto !important;
    cursor: pointer;
}

.refresh-progress {
    height: 2px;
    background: transparent;
    margin: 0 4px;
}

.refresh-progress-bar {
    height: 100%;
    background: #d1d5db; /* Light gray */
    transition: width 0.1s linear;
}

.sidebar-section {
  margin-bottom: 32px;
}

.sidebar-section:last-child {
  margin-bottom: 0;
}

.sidebar-title-link {
  display: block;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
  font-weight: 700;
  text-decoration: none;
  padding: 4px 8px;
  border-radius: 6px;
  transition: all 0.2s;
}

.sidebar-title-link:hover {
  background: #f1f5f9;
  color: var(--primary-color);
}

.sidebar-title-link.active {
  background: #eff6ff;
  color: var(--primary-color);
}

.collection-group {
  margin-bottom: 16px;
}

.collection-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.collection-title code {
  font-family: var(--font-mono);
  font-weight: 500;
  background: #f1f5f9;
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 12px;
}

.collection-title-link {
  display: block;
  font-size: 12px;
  font-weight: 500;
  font-family: var(--font-mono);
  margin: 0 0 8px 0;
  padding: 4px 8px;
  color: var(--text-secondary);
  text-decoration: none;
  cursor: pointer;
  border-radius: 4px;
  background: #f8fafc;
  border: 1px solid transparent;
  transition: all 0.15s;
}

.collection-title-link:hover {
  background: #e2e8f0;
  color: var(--text-primary);
}

.collection-title-link.active {
  background: #eff6ff;
  color: var(--primary-color);
  border-color: #dbeafe;
}

.sidebar-links {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar-link {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  color: var(--text-primary);
  text-decoration: none;
  font-size: 13px;
  border-radius: 6px;
  transition: all 0.2s;
  margin-bottom: 2px;
  gap: 8px;
}

.link-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-stats {
  display: flex;
  gap: 4px;
  align-items: center;
}

.stat-pipe {
  color: #d1d5db;
  font-size: 12px;
  margin: 0 2px;
}

.stat-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 4px;
  min-width: 12px;
  text-align: center;
}

.status-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  white-space: nowrap;
}

.stat-badge.error, .status-badge.error {
  background: #fef2f2;
  color: #dc2626;
  border: 1px solid #fee2e2;
}

.stat-badge.processing, .status-badge.processing {
  background: #eff6ff;
  color: #2563eb;
  border: 1px solid #dbeafe;
}

.stat-badge.pending {
  background: #f8fafc;
  color: #64748b;
  border: 1px solid #f1f5f9;
}

.stat-badge.success {
  background: #f0fdf4;
  color: #16a34a;
  border: 1px solid #dcfce7;
}

.stat-badge.warning {
  background: #ffedd5;
  color: #c2410c;
  border: 1px solid #fed7aa;
}

.sidebar-link.status-failed .link-label {
  color: #dc2626;
}

.cron-next-run {
  font-size: 10px;
  color: #9ca3af;
  margin-left: auto;
}

.sidebar-link:hover {
  background: #f1f5f9;
  color: var(--primary-color);
}

.sidebar-link.active {
  background: #eff6ff;
  color: var(--primary-color);
  font-weight: 500;
}

.sidebar-link.active .link-bullet {
  color: var(--primary-color);
}

/* Common Components Styles */
.card {
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  overflow: hidden;
  margin-bottom: 24px;
}

.toolbar {
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

input[type="text"], select {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 14px;
}

button.btn {
  padding: 8px 16px;
  background-color: var(--primary-color);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.2s;
}

button.btn:hover:not(:disabled) { background-color: var(--primary-hover); }
button.btn:disabled { opacity: 0.5; cursor: not-allowed; }

button.btn-secondary {
  background-color: white;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}

button.btn-secondary:hover:not(:disabled) { background-color: #f1f5f9; }

button.btn-danger { background-color: var(--danger-color); }
button.btn-danger:hover:not(:disabled) { background-color: #dc2626; }

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

th {
  background-color: #f8fafc;
  text-align: left;
  padding: 12px 16px;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  vertical-align: middle;
}

td code {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-primary);
}

tr:last-child td { border-bottom: none; }

.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 500;
}

.status-pending { background: #f3f4f6; color: #4b5563; }
.status-processing { background: #dbf4ff; color: #0369a1; }
.status-completed { background: #dcfce7; color: #15803d; }
.status-failed { background: #fee2e2; color: #b91c1c; }
.status-locked { background: #ede9fe; color: #6d28d9; }
.status-warning { background: #ffedd5; color: #c2410c; }

.pagination {
  padding: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid var(--border-color);
}

.error-text {
  color: var(--danger-color);
  font-size: 12px;
  display: block;
  margin-top: 4px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.settings-btn {
  background: none;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 8px;
  color: var(--text-secondary);
  border-radius: 6px;
  transition: all 0.2s;
  height: 35px; /* Match auto-refresh select height roughly */
  width: 35px;
}

.settings-btn:hover {
  background-color: #f1f5f9;
  color: var(--text-primary);
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--card-bg);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  min-width: 300px;
  max-width: 90%;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.modal-close {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--text-secondary);
  line-height: 1;
  padding: 0;
}

.modal-close:hover {
  color: var(--text-primary);
}

.modal-body {
  padding: 20px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.setting-row span {
  font-size: 14px;
  color: var(--text-primary);
}

.setting-row select {
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 14px;
}
</style>
