<script setup>
import { RouterLink, RouterView } from 'vue-router';
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">SNMP</span>
        <div>
          <h1>表采集工作台</h1>
          <p class="subtitle">按 MIB 定义解码索引，只在本机回环端口演示</p>
        </div>
      </div>
      <nav class="nav">
        <RouterLink to="/" active-class="active" exact-active-class="active">采集</RouterLink>
        <RouterLink to="/demo" active-class="active">演示代理</RouterLink>
        <RouterLink to="/history" active-class="active">历史记录</RouterLink>
      </nav>
    </header>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>
