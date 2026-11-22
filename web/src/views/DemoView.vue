<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';

const loading = ref(true);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const fixtures = ref({ faultModes: [], defaultHoles: {}, rows: {}, tables: [] });
const controls = ref({ enabled: true, community: 'public', faultMode: 'none', columnFaults: {}, holes: {} });
const health = ref(null);

const tables = computed(() => fixtures.value.tables || []);
const faultModes = computed(() => fixtures.value.faultModes || []);

const faultDescription = computed(() => {
  const mode = faultModes.value.find((item) => item.id === controls.value.faultMode);
  return mode ? mode.description : '';
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [fixturePayload, controlsPayload, healthPayload] = await Promise.all([
      api.fixtures(),
      api.controls(),
      api.health(),
    ]);
    fixtures.value = fixturePayload;
    controls.value = controlsPayload.controls;
    health.value = healthPayload;
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

function tableFixture(tableName) {
  return fixtures.value.tables.find((table) => table.name === tableName) || null;
}

function rowsOf(tableName) {
  return fixtures.value.rows[tableName] || [];
}

/** Holes can only target columns that exist in the current table. */
function holeList(tableName, columnName) {
  const holes = controls.value.holes || {};
  return (holes[tableName] && holes[tableName][columnName]) || [];
}

function holeKey(index) {
  return JSON.stringify(index);
}

function isHole(tableName, columnName, index) {
  return holeList(tableName, columnName).some((item) => holeKey(item) === holeKey(index));
}

function toggleHole(tableName, columnName, index) {
  const holes = JSON.parse(JSON.stringify(controls.value.holes || {}));
  if (!holes[tableName]) holes[tableName] = {};
  const list = holes[tableName][columnName] || [];
  const key = holeKey(index);
  holes[tableName][columnName] = list.some((item) => holeKey(item) === key)
    ? list.filter((item) => holeKey(item) !== key)
    : [...list, index];
  if (!holes[tableName][columnName].length) delete holes[tableName][columnName];
  controls.value.holes = holes;
}

function columnFault(columnName) {
  return (controls.value.columnFaults || {})[columnName] || 'inherit';
}

function setColumnFault(columnName, mode) {
  const next = { ...(controls.value.columnFaults || {}) };
  if (mode === 'inherit') delete next[columnName];
  else next[columnName] = mode;
  controls.value.columnFaults = next;
}

function indexDisplay(tableName, index) {
  const table = tableFixture(tableName);
  if (!table) return JSON.stringify(index);
  return table.indexParts
    .map((part, i) => `${part.name}=${formatIndexValue(index[i])}`)
    .join(', ');
}

function formatIndexValue(value) {
  if (Array.isArray(value)) return value.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return String(value);
}

function activeHoleCount() {
  let count = 0;
  for (const columns of Object.values(controls.value.holes || {})) {
    for (const indexes of Object.values(columns || {})) count += indexes.length;
  }
  return count;
}

async function save() {
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    const payload = await api.updateControls({
      enabled: controls.value.enabled,
      community: controls.value.community,
      faultMode: controls.value.faultMode,
      columnFaults: controls.value.columnFaults,
      holes: controls.value.holes,
    });
    controls.value = payload.controls;
    notice.value = '演示代理设置已生效（下一次读取立刻使用）。';
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    saving.value = false;
  }
}

async function reset() {
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    const payload = await api.resetDemo();
    controls.value = payload.controls;
    notice.value = '已恢复默认空洞与正常响应。';
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>演示代理</h2>
        <p class="muted small">
          代理监听
          <code v-if="health && health.demoAgent">{{ health.demoAgent.host }}:{{ health.demoAgent.port }}</code>
          <code v-else>127.0.0.1</code>
          （UDP，SNMPv2c，仅回环）。修改后点击“应用”。
        </p>
      </div>
      <div class="controls-inline">
        <button class="ghost" :disabled="saving" @click="reset">恢复默认</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '应用' }}</button>
      </div>
    </div>

    <p v-if="loading" class="muted">加载演示设置…</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div v-if="!loading" class="demo-grid">
      <div class="demo-card">
        <h3>代理行为</h3>
        <label class="toggle">
          <input v-model="controls.enabled" type="checkbox" />
          <span>代理应答请求</span>
        </label>
        <label class="field">
          <span>Community</span>
          <input v-model="controls.community" type="text" maxlength="64" />
        </label>
        <label class="field">
          <span>全局异常模式</span>
          <select v-model="controls.faultMode">
            <option v-for="mode in faultModes" :key="mode.id" :value="mode.id">{{ mode.label }}</option>
          </select>
        </label>
        <p class="muted small">{{ faultDescription }}</p>
        <p class="muted small">当前共删除 {{ activeHoleCount() }} 个列值。</p>
      </div>

      <div class="demo-card wide">
        <h3>每列异常覆盖</h3>
        <p class="muted small">留空继承全局模式。异常只影响该列自己的子树。</p>
        <div v-for="table in tables" :key="table.name" class="fault-table">
          <h4>{{ table.name }}</h4>
          <div class="fault-row" v-for="columnName in table.columns" :key="columnName">
            <code>{{ columnName }}</code>
            <select :value="columnFault(columnName)" @change="setColumnFault(columnName, $event.target.value)">
              <option value="inherit">继承全局</option>
              <option v-for="mode in faultModes" :key="mode.id" :value="mode.id">{{ mode.label }}</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!loading" class="hole-section">
      <h3>删除列值（制造空洞）</h3>
      <p class="muted small">
        勾选某行某列后，代理不再返回该实例。采集端必须按实例后缀拼行，空洞上方与下方的值不能互相顶替。
      </p>
      <div v-for="table in tables" :key="table.name" class="hole-table-block">
        <h4>{{ table.name }}</h4>
        <table class="hole-table">
          <thead>
            <tr>
              <th>行索引</th>
              <th v-for="columnName in table.columns" :key="columnName">{{ columnName }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rowsOf(table.name)" :key="JSON.stringify(row.index)">
              <td>{{ indexDisplay(table.name, row.index) }}</td>
              <td v-for="columnName in table.columns" :key="columnName">
                <label v-if="row.cells[columnName] !== undefined" class="hole-toggle">
                  <input
                    type="checkbox"
                    :checked="isHole(table.name, columnName, row.index)"
                    @change="toggleHole(table.name, columnName, row.index)"
                  />
                  <span class="muted tiny">删除</span>
                </label>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
