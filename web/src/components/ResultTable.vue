<script setup>
import { computed } from 'vue';

const props = defineProps({
  run: { type: Object, required: true },
  expanded: { type: Set, default: () => new Set() },
  statusText: { type: Function, default: (status) => status },
});

const emit = defineEmits(['toggle-row']);

const columns = computed(() => props.run.columns || []);
const indexParts = computed(() => props.run.indexParts || []);

function cell(row, columnName) {
  return row.cells[columnName] || { status: 'not-read', valueText: '', display: '', oid: '' };
}

function isPresent(row, columnName) {
  return cell(row, columnName).status === 'present';
}

function display(row, columnName) {
  const value = cell(row, columnName);
  if (value.status !== 'present') return '';
  return value.display ?? value.valueText ?? '';
}

function cellClass(row, columnName) {
  return `cell-${cell(row, columnName).status}`;
}

function walkFor(column) {
  return (props.run.walks || []).find((walk) => walk.column === column.name) || column.walk || null;
}

function isExpanded(row) {
  return props.expanded.has(row.rowKey);
}
</script>

<template>
  <div class="result-wrap">
    <div class="column-health">
      <div v-for="column in columns" :key="column.name" class="health-card">
        <div class="health-title">
          <strong>{{ column.name }}</strong>
          <span class="muted small">{{ column.baseType }}</span>
        </div>
        <code class="health-oid">{{ column.oid }}</code>
        <div v-if="walkFor(column)" class="health-meta small">
          <span :class="{ bad: !walkFor(column).normalEnd }">
            {{ walkFor(column).normalEnd ? '正常结束' : '异常结束' }} · {{ walkFor(column).endReason }}
          </span>
          <span class="muted">
            {{ walkFor(column).entries }} 个实例 / {{ walkFor(column).requests }} 次请求
          </span>
          <span v-if="walkFor(column).error" class="bad small">{{ walkFor(column).error }}</span>
        </div>
      </div>
    </div>

    <table class="result-table">
      <thead>
        <tr>
          <th class="ordinal">#</th>
          <th>行索引</th>
          <th>状态</th>
          <th v-for="column in columns" :key="column.name">
            {{ column.name }}
            <span class="muted small">.{{ column.number }}</span>
          </th>
          <th class="expand-col"></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in run.rows" :key="row.rowKey">
          <tr :class="`row-${row.status}`">
            <td class="ordinal">{{ row.ordinal }}</td>
            <td>
              <span class="index-display">{{ row.indexDisplay || `后缀 ${row.indexOid}` }}</span>
              <code class="index-oid muted small">.{{ row.indexOid }}</code>
            </td>
            <td>
              <span class="badge" :class="`badge-${row.status}`">{{ statusText(row.status) }}</span>
            </td>
            <td v-for="column in columns" :key="column.name" :class="cellClass(row, column.name)">
              <template v-if="isPresent(row, column.name)">
                <span class="value">{{ display(row, column.name) }}</span>
                <span
                  v-if="cell(row, column.name).enumLabel"
                  class="muted tiny"
                >{{ cell(row, column.name).enumLabel }}</span>
              </template>
              <span v-else class="missing" :title="cell(row, column.name).status">
                {{ cell(row, column.name).status === 'missing' ? '—' : '未读取' }}
              </span>
            </td>
            <td class="expand-col">
              <button class="ghost tiny" @click="emit('toggle-row', row.rowKey)">
                {{ isExpanded(row) ? '收起' : '来源 OID' }}
              </button>
            </td>
          </tr>
          <tr v-if="isExpanded(row)" class="source-row">
            <td></td>
            <td colspan="3" class="source-title">
              行键 <code>{{ row.rowKey }}</code> 来自以下实例 OID
            </td>
            <td :colspan="columns.length + 1">
              <table class="source-table">
                <thead>
                  <tr>
                    <th>列</th>
                    <th>实例 OID</th>
                    <th>状态</th>
                    <th>原始值</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="column in columns" :key="column.name">
                    <td>{{ column.name }}</td>
                    <td><code>{{ cell(row, column.name).oid }}</code></td>
                    <td>
                      <span class="badge" :class="`badge-cell-${cell(row, column.name).status}`">
                        {{ cell(row, column.name).status }}
                      </span>
                    </td>
                    <td>
                      <template v-if="isPresent(row, column.name)">
                        <span>{{ cell(row, column.name).valueText }}</span>
                        <span v-if="cell(row, column.name).typeName" class="muted tiny">
                          ({{ cell(row, column.name).typeName }})
                        </span>
                        <span v-if="cell(row, column.name).rawHex" class="muted tiny hex">
                          {{ cell(row, column.name).rawHex }}
                        </span>
                      </template>
                      <span v-else class="muted">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="indexParts.length" class="muted small source-index">
                索引解码：
                <span v-for="(part, i) in indexParts" :key="part.name">
                  {{ part.name }} = {{ row.indexValues && row.indexValues[i] ? (row.indexValues[i].display ?? row.indexValues[i].value) : '?' }}
                  <template v-if="i < indexParts.length - 1">; </template>
                </span>
              </p>
              <p v-else class="muted small">该表没有 INDEX 定义，行按实例后缀区分。</p>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-if="!run.rows.length" class="muted">没有读到任何行。</p>
  </div>
</template>
