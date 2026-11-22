<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import ResultTable from '../components/ResultTable.vue';

const route = useRoute();
const router = useRouter();

const runs = ref([]);
const run = ref(null);
const loading = ref(true);
const error = ref('');
const expanded = ref(new Set());

const selectedId = computed(() => (route.params.id ? Number(route.params.id) : null));

const STATUS_TEXT = {
  complete: '完整',
  partial: '有空洞',
  'incomplete-walk': '读取中断',
  'index-error': '索引错误',
};

function statusText(status) {
  return STATUS_TEXT[status] || status;
}

function toggleRow(key) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

async function loadList() {
  loading.value = true;
  error.value = '';
  try {
    const payload = await api.runs();
    runs.value = payload.runs;
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

async function loadRun(id) {
  if (!id) {
    run.value = null;
    return;
  }
  error.value = '';
  try {
    run.value = await api.run(id);
    expanded.value = new Set();
  } catch (requestError) {
    error.value = requestError.message;
    run.value = null;
  }
}

async function remove(id) {
  if (!window.confirm(`删除运行 #${id}？`)) return;
  try {
    await api.deleteRun(id);
    if (selectedId.value === id) router.push('/history');
    await loadList();
  } catch (requestError) {
    error.value = requestError.message;
  }
}

function formatTime(value) {
  return new Date(value).toLocaleString();
}

watch(
  selectedId,
  (id) => loadRun(id),
  { immediate: true },
);

onMounted(loadList);
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>历史记录</h2>
        <p class="muted small">每次读取结果保存在本地 SQLite，包含缺失状态与每格来源 OID。</p>
      </div>
      <button class="ghost" @click="loadList">刷新</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="loading" class="muted">加载中…</p>
    <p v-else-if="!runs.length" class="muted">还没有读取记录。</p>

    <table v-if="runs.length" class="run-list">
      <thead>
        <tr>
          <th>#</th>
          <th>时间</th>
          <th>表</th>
          <th>状态</th>
          <th>行数</th>
          <th>批量</th>
          <th>代理</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in runs" :key="item.id" :class="{ selected: item.id === selectedId }">
          <td>{{ item.id }}</td>
          <td>{{ formatTime(item.createdAt) }}</td>
          <td>{{ item.tableName }}</td>
          <td>
            <span class="badge" :class="item.status === 'ok' ? 'badge-complete' : 'badge-partial'">
              {{ item.status }}
            </span>
          </td>
          <td>{{ item.rowCount }}</td>
          <td>{{ item.bulkSize }}</td>
          <td><code>{{ item.agentHost }}:{{ item.agentPort }}</code></td>
          <td class="row-actions">
            <RouterLink class="button tiny" :to="`/history/${item.id}`">查看</RouterLink>
            <a class="button tiny" :href="api.exportCsvUrl(item.id)">CSV</a>
            <a class="button tiny" :href="api.exportJsonUrl(item.id)">JSON</a>
            <button class="ghost tiny danger" @click="remove(item.id)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>

  <section v-if="run" class="panel">
    <div class="panel-head">
      <div>
        <h2>运行 #{{ run.id }} · {{ run.table.name }}</h2>
        <p class="muted small">
          {{ formatTime(run.createdAt) }} · {{ run.rows.length }} 行 · 批量 {{ run.bulkSize }} ·
          {{ run.agent.host }}:{{ run.agent.port }}
        </p>
      </div>
      <div class="controls-inline">
        <a class="button" :href="api.exportCsvUrl(run.id)">导出 CSV</a>
        <a class="button" :href="api.exportJsonUrl(run.id)">导出 JSON</a>
      </div>
    </div>

    <p v-if="run.summary.warnings.length" class="warnings">
      <span v-for="(warning, i) in run.summary.warnings" :key="i" class="warning-line">⚠ {{ warning }}</span>
    </p>

    <ResultTable :run="run" :status-text="statusText" :expanded="expanded" @toggle-row="toggleRow" />
  </section>
</template>
