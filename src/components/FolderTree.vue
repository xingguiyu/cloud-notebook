<script setup lang="ts">
import { Folder } from 'lucide-vue-next'
import type { Entry } from '../vault'

defineProps<{ entries: Entry[]; selected: string | null; depth?: number }>()
defineEmits<{ select: [string]; menu: [Entry] }>()
</script>

<template>
  <template v-for="e in entries.filter((x) => x.is_dir)" :key="e.path">
    <div
      class="side-item"
      :class="{ active: selected === e.path }"
      :style="{ paddingLeft: 12 + (depth ?? 0) * 14 + 'px' }"
      @click="$emit('select', e.path)"
      @contextmenu="$emit('menu', e)"
    >
      <Folder class="ico" :size="15" />
      <span class="label">{{ e.name }}</span>
    </div>
    <FolderTree
      :entries="e.children"
      :selected="selected"
      :depth="(depth ?? 0) + 1"
      @select="$emit('select', $event)"
      @menu="$emit('menu', $event)"
    />
  </template>
</template>
