/**
 * Fixture rows served by the local demo agent.
 *
 * Values are logical (integers, decimal strings for Counter64, byte arrays for
 * strings); the agent encodes them with the MIB column types and the shared
 * index codec, so the OID suffixes are produced by the same RFC 2578 rules
 * the collector decodes with.
 *
 * Several deliberate oddities exist so the collector can be observed doing the
 * right thing: non-contiguous integer indexes, a Counter64 above 2^53, an
 * embedded NUL in a MAC-style index, a two-octet UTF-8 index, holes.
 */

export const DEMO_ROWS = {
  demoDeviceTable: [
    {
      index: [1],
      cells: {
        demoDeviceIndex: 1,
        demoDeviceName: 'edge-01',
        demoDeviceStatus: 1,
        demoDeviceRxBytes: '18446744073709550000',
        demoDeviceTxBytes: '9007199254740993',
        demoDeviceLoad: 12,
        demoDeviceUptime: 8640000,
        demoDeviceAddress: [0x00, 0x11, 0x22, 0x33, 0x44, 0x55],
        demoDeviceLabel: '机房 A · 核心交换机',
      },
    },
    {
      index: [3],
      cells: {
        demoDeviceIndex: 3,
        demoDeviceName: 'edge-03',
        demoDeviceStatus: 3,
        demoDeviceRxBytes: '999999999999999999',
        demoDeviceTxBytes: '12000000000000000000',
        demoDeviceLoad: 87,
        demoDeviceUptime: 4320000,
        demoDeviceAddress: [0x00, 0x11, 0x22, 0x33, 0x44, 0x77],
        demoDeviceLabel: 'Row with a hole in demoDeviceTxBytes below by default',
      },
    },
    {
      index: [10],
      cells: {
        demoDeviceIndex: 10,
        demoDeviceName: 'edge-10',
        demoDeviceStatus: 2,
        demoDeviceRxBytes: '0',
        demoDeviceTxBytes: '0',
        demoDeviceLoad: 0,
        demoDeviceUptime: 0,
        demoDeviceAddress: [0xde, 0xad, 0xbe, 0xef, 0x00, 0x01],
        demoDeviceLabel: 'never came up',
      },
    },
  ],

  demoSensorTable: [
    {
      index: [1, 'cpu-temp'],
      cells: {
        demoSensorSlot: 1,
        demoSensorName: 'cpu-temp',
        demoSensorValue: 43,
        demoSensorUnit: 'C',
        demoSensorValid: 1,
        demoSensorSamples: '18374686479671623680',
      },
    },
    {
      index: [1, 'inlet-temp'],
      cells: {
        demoSensorSlot: 1,
        demoSensorName: 'inlet-temp',
        demoSensorValue: 27,
        demoSensorUnit: 'C',
        demoSensorValid: 1,
        demoSensorSamples: '9000',
      },
    },
    {
      index: [2, 'fan-rpm'],
      cells: {
        demoSensorSlot: 2,
        demoSensorName: 'fan-rpm',
        demoSensorValue: 12000,
        demoSensorUnit: 'rpm',
        demoSensorValid: 1,
        demoSensorSamples: '2147483648',
      },
    },
    {
      // A two-octet UTF-8 index in the second component: the length prefix
      // covers bytes, not characters.
      index: [2, '温度'],
      cells: {
        demoSensorSlot: 2,
        demoSensorName: '温度',
        demoSensorValue: 51,
        demoSensorUnit: 'C',
        demoSensorValid: 2,
        demoSensorSamples: '17',
      },
    },
    {
      index: [7, 'psu-current'],
      cells: {
        demoSensorSlot: 7,
        demoSensorName: 'psu-current',
        demoSensorValue: 3400,
        demoSensorUnit: 'mA',
        demoSensorValid: 1,
        demoSensorSamples: '12345678901234567890',
      },
    },
  ],

  demoTunnelTable: [
    {
      index: ['192.0.2.10', 'peer-alpha'],
      cells: {
        demoTunnelLocal: '192.0.2.10',
        demoTunnelPeer: 'peer-alpha',
        demoTunnelState: 1,
        demoTunnelLatency: 800,
        demoTunnelPackets: '5000000000000000000',
      },
    },
    {
      index: ['192.0.2.10', 'peer-beta'],
      cells: {
        demoTunnelLocal: '192.0.2.10',
        demoTunnelPeer: 'peer-beta',
        demoTunnelState: 0,
        demoTunnelLatency: 12000,
        demoTunnelPackets: '42',
      },
    },
    {
      index: ['198.51.100.7', 'peer-gamma'],
      cells: {
        demoTunnelLocal: '198.51.100.7',
        demoTunnelPeer: 'peer-gamma',
        demoTunnelState: 2,
        demoTunnelLatency: 320,
        demoTunnelPackets: '7777777777777777777',
      },
    },
  ],

  demoMacTable: [
    {
      // The middle octets include 0x00: a parser that treats the index as a
      // string will truncate or mis-split this row.
      index: [[0x00, 0x11, 0x22, 0x00, 0x33, 0x44]],
      cells: {
        demoMacAddress: [0x00, 0x11, 0x22, 0x00, 0x33, 0x44],
        demoMacVlan: 100,
        demoMacPort: 'Gi1/0/1',
        demoMacSeen: '5000000000000000000',
      },
    },
    {
      index: [[0x02, 0x00, 0x00, 0x00, 0x00, 0x01]],
      cells: {
        demoMacAddress: [0x02, 0x00, 0x00, 0x00, 0x00, 0x01],
        demoMacVlan: 100,
        demoMacPort: 'Gi1/0/2',
        demoMacSeen: '7',
      },
    },
    {
      index: [[0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]],
      cells: {
        demoMacAddress: [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff],
        demoMacVlan: 200,
        demoMacPort: 'Gi2/0/1',
        demoMacSeen: '123456789012345678',
      },
    },
  ],
};

/** Default holes: table -> column -> list of row indexes that are absent. */
export const DEMO_HOLES = {
  demoDeviceTable: {
    demoDeviceTxBytes: [[3], [10]],
    demoDeviceUptime: [[10]],
  },
  demoSensorTable: {
    demoSensorSamples: [[2, '温度']],
  },
  demoTunnelTable: {},
  demoMacTable: {
    demoMacPort: [[[0x02, 0x00, 0x00, 0x00, 0x00, 0x01]]],
  },
};

export const FAULT_MODES = [
  {
    id: 'none',
    label: '正常响应',
    description: '按 RFC 2578 顺序推进，越过所选列子树时结束。',
    affects: 'per-request',
  },
  {
    id: 'repeat-last',
    label: '重复最后一个 OID',
    description: '第二次及以后的 GETBULK 重新返回上一轮最后一个实例，OID 不再前进。',
    affects: 'per-varbind',
  },
  {
    id: 'out-of-order',
    label: '乱序 OID',
    description: '返回的第二个实例比上一轮的 OID 小，越过顺序检查。',
    affects: 'per-varbind',
  },
  {
    id: 'no-advance',
    label: '返回空 varbind 列表',
    description: 'GETBULK 响应体为空，游标永远不会推进。',
    affects: 'per-request',
  },
  {
    id: 'no-end-of-mib',
    label: '越过子树也继续',
    description: '越过列子树后仍反复返回该列最后一个实例，模拟永不结束的 walk。',
    affects: 'per-varbind',
  },
  {
    id: 'stop-mid',
    label: '中途结束',
    description: '该列只给出前两个实例，随后返回 endOfMibView；采集端无法区分它与“该列本来就这么少数据”，但缺失的单元格会标为 missing。',
    affects: 'per-varbind',
  },  {
    id: 'timeout',
    label: '丢弃请求（超时）',
    description: '对包含该列的请求不响应，由采集端超时机制报错。',
    affects: 'per-request',
  },
  {
    id: 'error-status',
    label: '错误状态 genErr',
    description: '响应 PDU 返回 genErr 与 errorIndex，不带值。',
    affects: 'per-varbind',
  },
  {
    id: 'omit-column',
    label: '列消失（跳过子树）',
    description: '该列从代理视图消失；GET 返回 noSuchInstance，GETBULK 跳过整个列。',
    affects: 'per-varbind',
  },
];
