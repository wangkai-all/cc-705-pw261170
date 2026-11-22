<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import ResultTable from '../components/ResultTable.vue';

const router = useRouter();

const loading = ref(true);
const error = ref('');
const mibs = ref({ tables: [], errors: [] });
const selectedTable = ref('');
const selectedColumns = ref([]);
const bulkSize = ref(5);
const collecting = ref(false);
const result = ref(null);
const expanded = ref(new Set());

const table = computed(() => mibs.value.tables.find((item) => item.name === selectedTable.value) || null);

const readableColumns = computed(() =>
  table.value ? table.value.columns.filter((column) => column.readable) : [],
);

const canCollect = computed(
  () => Boolean(table.value) && selectedColumns.value.length > 0 && !collecting.value,
);

async function loadMibs() {
  loading.value = true;
  error.value = '';
  try {
    mibs.value = await api.mibs();
    if (mibs.value.tables.length) {
      selectTable(mibs.value.tables[0].name);
    }
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

function selectTable(name) {
  selectedTable.value = name;
  result.value = null;
  expanded.value = new Set();
  const current = mibs.value.tables.find((item) => item.name === name);
  if (!current) {
    selectedColumns.value = [];
    return;
  }
  selectedColumns.value = preferredColumns(current);
}

/** Index columns first, then the rest, capped so the default read is small. */
function preferredColumns(current) {
  const readable = current.columns.filter((column) => column.readable);
  const indexes = readable.filter((column) => column.isIndex).map((column) => column.name);
  const others = readable.filter((column) => !column.isIndex).map((column) => column.name);
  return [...indexes, ...others].slice(0, 8);
}

function toggleColumn(name) {
  if (selectedColumns.value.includes(name)) {
    selectedColumns.value = selectedColumns.value.filter((item) => item !== name);
  } else {
    selectedColumns.value = [...selectedColumns.value, name];
  }
}

// Keep the walk order deterministic: the MIB column order, not click order.
const orderedSelection = computed(() => {
  if (!table.value) return [];
  return table.value.columns
    .map((column) => column.name)
    .filter((name) => selectedColumns.value.includes(name));
});

async function collect() {
  if (!canCollect.value) return;
  collecting.value = true;
  error.value = '';
  try {
    const run = await api.collect({
      table: selectedTable.value,
      columns: orderedSelection.value,
      bulkSize: Number(bulkSize.value),
    });
    result.value = run;
    expanded.value = new Set();
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    collecting.value = false;
  }
}

function selectAllReadable() {
  if (!table.value) return;
  selectedColumns.value = readableColumns.value.map((column) => column.name);
}

function clearSelection() {
  selectedColumns.value = [];
}

onMounted(loadMibs);

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

function openHistory(id) {
  router.push(`/history/${id}`);
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>选择表与列</h2>
        <p class="muted">
          MIB 定义来自 <code>{{ mibs.directory || 'mibs/' }}</code
          >。每列独立 GETBULK，行由实例 OID 后缀解码得到。
        </p>
      </div>
      <div class="controls-inline">
        <label class="field compact">
          <span>批量大小</span>
          <input v-model.number="bulkSize" type="number" min="1" max="50" />
        </label>
        <button class="primary" :disabled="!canCollect" @click="collect">
          {{ collecting ? '读取中…' : '开始读取' }}
        </button>
      </div>
    </div>

    <p v-if="loading" class="muted">正在解析 MIB…</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <div v-if="!loading && mibs.tables.length" class="collect-layout">
      <aside class="table-list">
        <button
          v-for="item in mibs.tables"
          :key="item.name"
          class="table-pill"
          :class="{ active: item.name === selectedTable }"
          @click="selectTable(item.name)"
        >
          <strong>{{ item.name }}</strong>
          <span class="muted small">{{ item.module }} · {{ item.columns.length }} 列</span>
        </button>
      </aside>

      <div v-if="table" class="column-panel">
        <div class="column-head">
          <div>
            <h3>{{ table.name }}</h3>
            <p class="muted small">
              表 OID <code>{{ table.oid }}</code>
            </p>
          </div>
          <div class="controls-inline">
            <button class="ghost" @click="selectAllReadable">全选</button>
            <button class="ghost" @click="clearSelection">清空</button>
          </div>
        </div>

        <div class="index-summary">
          <span class="tag">INDEX</span>
          <span v-for="(part, i) in table.indexParts" :key="part.name" class="index-part">
            {{ part.name }}
            <small class="muted">({{ part.kind }}<template v-if="part.implied">, IMPLIED</template
              ><template v-if="part.fixedLength">, SIZE {{ part.fixedLength }}</template
              ><template v-else-if="part.sizeMin || part.sizeMax">, {{ part.sizeMin }}..{{ part.sizeMax }}</template
              >)</small>
            <span v-if="i < table.indexParts.length - 1" class="muted">, </span>
          </span>
          <span v-if="table.augments" class="tag warn">AUGMENTS {{ table.augments }}</span>
        </div>

        <ul class="column-grid">
          <li v-for="column in table.columns" :key="column.name">
            <label class="column-item" :class="{ disabled: !column.readable }">
              <input
                type="checkbox"
                :disabled="!column.readable"
                :checked="selectedColumns.includes(column.name)"
                @change="toggleColumn(column.name)"
              />
              <span class="column-name">
                {{ column.name }}
                <span v-if="column.isIndex" class="tag tiny">索引</span>
              </span>
              <span class="column-meta muted small">
                .{{ column.number }} · {{ column.baseType }}
                <template v-if="column.enumeration"> · 枚举</template>
                <template v-if="!column.readable"> · 不可读</template>
              </span>
              <code class="column-oid">{{ column.oid }}</code>
            </label>
          </li>
        </ul>
      </div>
      <p v-else class="muted">该项目没有可用的表定义。</p>
    </div>
    <p v-else-if="!loading" class="muted">
      未在 MIB 目录中找到表定义。<template v-if="mibs.errors && mibs.errors.length">
        解析错误：{{ mibs.errors.map((item) => item.file).join(', ') }}
      </template>
    </p>
  </section>

  <section v-if="result" class="panel">
    <div class="panel-head">
      <div>
        <h2>读取结果</h2>
        <p class="muted small">
          运行 #{{ result.id }} · {{ result.rows.length }} 行 · 完成 {{ result.summary.completeRows }} /
          部分 {{ result.summary.partialRows }} / 中断 {{ result.summary.incompleteWalkRows }} · 用时
          {{ result.diagnostics.durationMs }} ms
        </p>
      </div>
      <div class="controls-inline">
        <a class="button" :href="api.exportCsvUrl(result.id)">导出 CSV</a>
        <a class="button" :href="api.exportJsonUrl(result.id)">导出 JSON</a>
        <button class="ghost" @click="openHistory(result.id)">在历史中打开</button>
      </div>
    </div>

    <p v-if="result.summary.warnings.length" class="warnings">
      <span v-for="(warning, i) in result.summary.warnings" :key="i" class="warning-line">⚠ {{ warning }}</span>
    </p>

    <ResultTable
      :run="result"
      :status-text="statusText"
      :expanded="expanded"
      @toggle-row="toggleRow"
    />
  </section>
</template>
