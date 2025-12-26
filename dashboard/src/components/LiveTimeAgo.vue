<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { formatDistanceToNow } from 'date-fns'

const props = defineProps<{
  date?: Date | string | null
}>()

const now = ref(Date.now())
let timer: any = null

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const timeString = computed(() => {
  if (!props.date) return '-'
  // Depends on `now` to trigger reactivity
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  now.value
  return formatDistanceToNow(new Date(props.date), {
    addSuffix: true,
    includeSeconds: true
  })
})
</script>

<template>
  <span>{{ timeString }}</span>
</template>
