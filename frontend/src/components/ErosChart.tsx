'use client'

import { useMemo, useState } from 'react'
import dynamic from 'next/dynamic'

// Dynamic imports for code splitting — Nivo is heavy
const ResponsiveBar = dynamic(() => import('@nivo/bar').then(m => m.ResponsiveBar), { ssr: false })
const ResponsivePie = dynamic(() => import('@nivo/pie').then(m => m.ResponsivePie), { ssr: false })
const ResponsiveLine = dynamic(() => import('@nivo/line').then(m => m.ResponsiveLine), { ssr: false })
const ResponsiveRadar = dynamic(() => import('@nivo/radar').then(m => m.ResponsiveRadar), { ssr: false })
const ResponsiveScatterPlot = dynamic(() => import('@nivo/scatterplot').then(m => m.ResponsiveScatterPlot), { ssr: false })
const ResponsiveHeatMap = dynamic(() => import('@nivo/heatmap').then(m => m.ResponsiveHeatMap), { ssr: false })

// Chart JSON format from Eros AI
export interface ChartConfig {
  type: 'bar' | 'pie' | 'line' | 'radar' | 'scatter' | 'area' | 'stacked' | 'heatmap' | 'gauge'
  title?: string
  data: Record<string, string | number>[]
  keys?: string[]           // For bar charts: which fields to stack/group
  indexBy?: string           // For bar/radar: the category field
  colors?: string[]
  xLabel?: string
  yLabel?: string
  layout?: 'vertical' | 'horizontal'
  suggest?: boolean          // true = show button instead of auto-rendering
  // Gauge specific
  value?: number
  min?: number
  max?: number
  unit?: string
}

// Emerald/slate palette for charts
const defaultColors = [
  '#059669', '#10b981', '#34d399', '#6ee7b7',
  '#0ea5e9', '#38bdf8', '#818cf8', '#a78bfa',
  '#f472b6', '#fb923c', '#facc15', '#4ade80',
]

const chartTheme = {
  text: { fill: '#475569', fontSize: 11 },
  axis: {
    ticks: { text: { fill: '#64748b', fontSize: 10 } },
    legend: { text: { fill: '#334155', fontSize: 12, fontWeight: 600 } },
  },
  grid: { line: { stroke: '#e2e8f0', strokeWidth: 1 } },
  legends: { text: { fill: '#475569', fontSize: 11 } },
  tooltip: {
    container: {
      background: '#ffffff',
      color: '#334155',
      fontSize: 12,
      borderRadius: '8px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
      border: '1px solid #e2e8f0',
      padding: '8px 12px',
    },
  },
}

export default function ErosChart({ config, compact, onMaximize }: { config: ChartConfig; compact?: boolean; onMaximize?: (config: ChartConfig) => void }) {
  const baseHeight = compact ? 200 : 280
  const [isFullscreen, setIsFullscreen] = useState(false)
  const colors = config.colors?.length ? config.colors : defaultColors
  const height = (isFullscreen && !onMaximize) ? Math.min(window.innerHeight - 120, 600) : baseHeight

  const chart = useMemo(() => {
    switch (config.type) {
      case 'bar':
        return (
          <ResponsiveBar
            data={config.data}
            keys={config.keys || Object.keys(config.data[0] || {}).filter(k => k !== (config.indexBy || 'label'))}
            indexBy={config.indexBy || 'label'}
            margin={{ top: 10, right: compact ? 20 : 40, bottom: compact ? 40 : 50, left: compact ? 50 : 60 }}
            padding={0.3}
            colors={colors}
            borderRadius={4}
            layout={config.layout || 'vertical'}
            axisBottom={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.xLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: 40,
            }}
            axisLeft={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.yLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: -50,
            }}
            labelSkipWidth={16}
            labelSkipHeight={16}
            labelTextColor="#ffffff"
            theme={chartTheme}
            animate={true}
            motionConfig="wobbly"
          />
        )

      case 'stacked':
        return (
          <ResponsiveBar
            data={config.data}
            keys={config.keys || Object.keys(config.data[0] || {}).filter(k => k !== (config.indexBy || 'label'))}
            indexBy={config.indexBy || 'label'}
            margin={{ top: 10, right: compact ? 20 : 40, bottom: compact ? 40 : 50, left: compact ? 50 : 60 }}
            padding={0.3}
            colors={colors}
            borderRadius={4}
            groupMode="stacked"
            layout={config.layout || 'vertical'}
            axisBottom={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.xLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: 40,
            }}
            axisLeft={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.yLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: -50,
            }}
            labelSkipWidth={16}
            labelSkipHeight={16}
            labelTextColor="#ffffff"
            theme={chartTheme}
            animate={true}
            motionConfig="wobbly"
            legends={[{
              dataFrom: 'keys',
              anchor: 'bottom-right',
              direction: 'column',
              translateX: 0,
              translateY: 0,
              itemWidth: 80,
              itemHeight: 18,
              itemTextColor: '#64748b',
              symbolSize: 10,
              symbolShape: 'circle',
            }]}
          />
        )

      case 'pie': {
        const pieData = config.data.map((d, i) => ({
          id: String(d[config.indexBy || 'label'] || d.id || `item-${i}`),
          label: String(d[config.indexBy || 'label'] || d.id || `item-${i}`),
          value: Number(d.value || d.count || d[config.keys?.[0] || 'value'] || 0),
        }))
        return (
          <ResponsivePie
            data={pieData}
            margin={{ top: 20, right: compact ? 20 : 80, bottom: 20, left: compact ? 20 : 80 }}
            innerRadius={0.5}
            padAngle={1.5}
            cornerRadius={4}
            colors={colors}
            borderWidth={1}
            borderColor={{ from: 'color', modifiers: [['darker', 0.2]] }}
            arcLinkLabelsSkipAngle={10}
            arcLinkLabelsTextColor="#475569"
            arcLinkLabelsThickness={2}
            arcLinkLabelsColor={{ from: 'color' }}
            arcLabelsSkipAngle={10}
            arcLabelsTextColor="#ffffff"
            enableArcLinkLabels={!compact}
            theme={chartTheme}
            animate={true}
            motionConfig="wobbly"
          />
        )
      }

      case 'line': {
        const xKey = config.indexBy || 'x'
        const lineKeys = config.keys || Object.keys(config.data[0] || {}).filter(k => k !== xKey)
        const lineData = lineKeys.map((key, i) => ({
          id: key,
          color: colors[i % colors.length],
          data: config.data.map(d => ({
            x: d[xKey],
            y: Number(d[key] || 0),
          })),
        }))
        return (
          <ResponsiveLine
            data={lineData}
            margin={{ top: 10, right: compact ? 20 : 40, bottom: compact ? 40 : 50, left: compact ? 50 : 60 }}
            xScale={{ type: 'point' }}
            yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
            curve="monotoneX"
            colors={colors}
            lineWidth={2.5}
            pointSize={8}
            pointColor={{ theme: 'background' }}
            pointBorderWidth={2}
            pointBorderColor={{ from: 'serieColor' }}
            enableGridX={false}
            axisBottom={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.xLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: 40,
            }}
            axisLeft={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.yLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: -50,
            }}
            theme={chartTheme}
            animate={true}
            motionConfig="wobbly"
            enableArea={false}
            useMesh={true}
          />
        )
      }

      case 'area': {
        const xKey = config.indexBy || 'x'
        const areaKeys = config.keys || Object.keys(config.data[0] || {}).filter(k => k !== xKey)
        const areaData = areaKeys.map((key, i) => ({
          id: key,
          color: colors[i % colors.length],
          data: config.data.map(d => ({
            x: d[xKey],
            y: Number(d[key] || 0),
          })),
        }))
        return (
          <ResponsiveLine
            data={areaData}
            margin={{ top: 10, right: compact ? 20 : 40, bottom: compact ? 40 : 50, left: compact ? 50 : 60 }}
            xScale={{ type: 'point' }}
            yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
            curve="monotoneX"
            colors={colors}
            lineWidth={2}
            pointSize={6}
            pointColor={{ theme: 'background' }}
            pointBorderWidth={2}
            pointBorderColor={{ from: 'serieColor' }}
            enableGridX={false}
            axisBottom={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.xLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: 40,
            }}
            axisLeft={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.yLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: -50,
            }}
            theme={chartTheme}
            animate={true}
            motionConfig="wobbly"
            enableArea={true}
            areaOpacity={0.3}
            useMesh={true}
          />
        )
      }

      case 'radar': {
        const radarKeys = config.keys || Object.keys(config.data[0] || {}).filter(k => k !== (config.indexBy || 'label'))
        return (
          <ResponsiveRadar
            data={config.data}
            keys={radarKeys}
            indexBy={config.indexBy || 'label'}
            maxValue="auto"
            margin={{ top: 30, right: compact ? 40 : 80, bottom: 30, left: compact ? 40 : 80 }}
            colors={colors}
            borderWidth={2}
            borderColor={{ from: 'color' }}
            gridLevels={4}
            gridShape="circular"
            gridLabelOffset={16}
            dotSize={8}
            dotColor={{ theme: 'background' }}
            dotBorderWidth={2}
            dotBorderColor={{ from: 'color' }}
            fillOpacity={0.25}
            blendMode="multiply"
            theme={chartTheme}
            animate={true}
            motionConfig="wobbly"
          />
        )
      }

      case 'scatter': {
        const xKey = config.indexBy || 'x'
        const yKeys = config.keys || Object.keys(config.data[0] || {}).filter(k => k !== xKey && k !== 'label' && k !== 'id' && k !== 'group')
        const groupKey = config.data[0]?.group !== undefined ? 'group' : null
        let scatterData: { id: string; data: { x: number; y: number }[] }[]

        if (groupKey) {
          const groups = new Map<string, { x: number; y: number }[]>()
          config.data.forEach(d => {
            const g = String(d[groupKey] || 'default')
            if (!groups.has(g)) groups.set(g, [])
            groups.get(g)!.push({ x: Number(d[xKey] || 0), y: Number(d[yKeys[0]] || 0) })
          })
          scatterData = Array.from(groups.entries()).map(([id, data]) => ({ id, data }))
        } else {
          scatterData = yKeys.map((key, i) => ({
            id: key,
            data: config.data.map(d => ({
              x: Number(d[xKey] || 0),
              y: Number(d[key] || 0),
            })),
          }))
          if (scatterData.length === 0) {
            scatterData = [{ id: 'data', data: config.data.map(d => ({ x: Number(d[xKey] || 0), y: Number(d.y || 0) })) }]
          }
        }

        return (
          <ResponsiveScatterPlot
            data={scatterData}
            margin={{ top: 10, right: compact ? 20 : 40, bottom: compact ? 40 : 50, left: compact ? 50 : 60 }}
            xScale={{ type: 'linear', min: 'auto', max: 'auto' }}
            yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
            colors={colors}
            nodeSize={10}
            axisBottom={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.xLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: 40,
            }}
            axisLeft={{
              tickSize: 0,
              tickPadding: 8,
              legend: config.yLabel || undefined,
              legendPosition: 'middle' as const,
              legendOffset: -50,
            }}
            theme={chartTheme}
            animate={true}
            motionConfig="wobbly"
            useMesh={true}
          />
        )
      }

      case 'heatmap': {
        const indexKey = config.indexBy || 'id'
        const hmKeys = config.keys || Object.keys(config.data[0] || {}).filter(k => k !== indexKey)
        const heatmapData = config.data.map(d => ({
          id: String(d[indexKey]),
          data: hmKeys.map(k => ({ x: k, y: Number(d[k] || 0) })),
        }))
        return (
          <ResponsiveHeatMap
            data={heatmapData}
            margin={{ top: 30, right: compact ? 20 : 40, bottom: compact ? 40 : 50, left: compact ? 60 : 80 }}
            axisTop={{
              tickSize: 0,
              tickPadding: 8,
            }}
            axisLeft={{
              tickSize: 0,
              tickPadding: 8,
            }}
            colors={{
              type: 'sequential',
              scheme: 'greens',
            }}
            borderRadius={3}
            borderWidth={1}
            borderColor="#e2e8f0"
            theme={chartTheme}
            animate={true}
            motionConfig="wobbly"
          />
        )
      }

      case 'gauge': {
        const val = config.value ?? (config.data?.[0] ? Number(config.data[0].value || config.data[0][config.keys?.[0] || 'value'] || 0) : 0)
        const min = config.min ?? 0
        const max = config.max ?? 100
        const unit = config.unit || '%'
        const pct = Math.max(0, Math.min(1, (val - min) / (max - min)))
        const startAngle = -135
        const endAngle = 135
        const sweepAngle = (endAngle - startAngle) * pct
        const r = 70
        const cx = 100
        const cy = 95

        const toRad = (deg: number) => (deg * Math.PI) / 180
        const arcPath = (start: number, sweep: number) => {
          const s = toRad(start - 90)
          const e = toRad(start + sweep - 90)
          const x1 = cx + r * Math.cos(s)
          const y1 = cy + r * Math.sin(s)
          const x2 = cx + r * Math.cos(e)
          const y2 = cy + r * Math.sin(e)
          const large = Math.abs(sweep) > 180 ? 1 : 0
          return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
        }

        const gaugeColor = pct < 0.33 ? '#ef4444' : pct < 0.66 ? '#f59e0b' : '#059669'

        return (
          <div className="flex flex-col items-center justify-center h-full">
            <svg viewBox="0 0 200 140" className="w-full max-w-[200px]">
              <path d={arcPath(startAngle, endAngle - startAngle)} fill="none" stroke="#e2e8f0" strokeWidth={14} strokeLinecap="round" />
              {sweepAngle > 0 && (
                <path d={arcPath(startAngle, sweepAngle)} fill="none" stroke={gaugeColor} strokeWidth={14} strokeLinecap="round"
                  style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.15))' }}
                >
                  <animate attributeName="stroke-dashoffset" from="300" to="0" dur="1s" fill="freeze" />
                </path>
              )}
              <text x={cx} y={cy - 4} textAnchor="middle" fontSize="28" fontWeight="700" fill="#1e293b">{val}</text>
              <text x={cx} y={cy + 16} textAnchor="middle" fontSize="12" fill="#64748b">{unit}</text>
              <text x={cx - r + 5} y={cy + 32} textAnchor="start" fontSize="10" fill="#94a3b8">{min}</text>
              <text x={cx + r - 5} y={cy + 32} textAnchor="end" fontSize="10" fill="#94a3b8">{max}</text>
            </svg>
          </div>
        )
      }

      default:
        return <div className="text-xs text-slate-400 p-4">Tipo de gráfico no soportado: {config.type}</div>
    }
  }, [config, compact, colors])

  return (
    <>
      {isFullscreen && !onMaximize && (
        <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setIsFullscreen(false)}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden"
            onClick={e => e.stopPropagation()}
            style={{ animation: 'eros-bounce-in 0.3s ease-out both' }}
          >
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/80 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-slate-700">{config.title || 'Gráfico'}</h4>
              <button
                onClick={() => setIsFullscreen(false)}
                className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors text-slate-500 hover:text-slate-700"
                title="Cerrar"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div style={{ height: Math.min(window.innerHeight - 120, 600) }} className="px-2">
              {chart}
            </div>
          </div>
        </div>
      )}
      <div className="my-2 rounded-xl border border-slate-200 bg-white overflow-hidden"
        style={{ animation: 'eros-chart-fade-in 0.5s ease-out both' }}
      >
        {config.title && (
          <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <h4 className="text-xs font-semibold text-slate-700">{config.title}</h4>
            <button
              onClick={() => onMaximize ? onMaximize(config) : setIsFullscreen(true)}
              className="p-1 hover:bg-slate-200 rounded transition-colors text-slate-400 hover:text-slate-600"
              title="Maximizar gráfico"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
            </button>
          </div>
        )}
        {!config.title && (
          <div className="flex justify-end px-2 pt-1">
            <button
              onClick={() => onMaximize ? onMaximize(config) : setIsFullscreen(true)}
              className="p-1 hover:bg-slate-100 rounded transition-colors text-slate-400 hover:text-slate-600"
              title="Maximizar gráfico"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
            </button>
          </div>
        )}
        <div style={{ height: baseHeight }} className="px-1">
          {chart}
        </div>
      </div>
    </>
  )
}

/** Normalize <chart type="bar" ...></chart> attribute format to <chart>{JSON}</chart> */
function normalizeChartAttributes(text: string): string {
  // Match <chart followed by attributes (not JSON), ending with ></chart> or /></chart>
  return text.replace(/<chart\s+((?:(?!<\/chart>)[\s\S])*?)\s*>\s*<\/chart>/g, (_match, attrs: string) => {
    try {
      const obj: Record<string, unknown> = {}
      // Parse key=value or key="value" or key=[...] patterns
      const attrRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\[[\s\S]*?\])|([^\s>]+))/g
      let m
      while ((m = attrRegex.exec(attrs)) !== null) {
        const key = m[1]
        const val = m[2] ?? m[3] ?? m[4] ?? m[5]
        if (val.startsWith('[') || val.startsWith('{')) {
          try { obj[key] = JSON.parse(val) } catch { obj[key] = val }
        } else if (val === 'true') { obj[key] = true }
        else if (val === 'false') { obj[key] = false }
        else if (!isNaN(Number(val)) && val !== '') { obj[key] = Number(val) }
        else { obj[key] = val }
      }
      if (obj.type) {
        return `<chart>${JSON.stringify(obj)}</chart>`
      }
    } catch { /* fall through */ }
    return _match
  })
}

/** Parse chart blocks from AI message text — matches <chart>JSON</chart> tags and ```chart/json code fences as fallback */
export function parseChartBlocks(text: string): { segments: Array<{ type: 'text' | 'chart'; content: string; config?: ChartConfig; isSuggestion?: boolean }> } {
  // Normalize attribute-style chart tags before parsing
  const normalizedText = normalizeChartAttributes(text)
  const segments: Array<{ type: 'text' | 'chart'; content: string; config?: ChartConfig; isSuggestion?: boolean }> = []
  // Match <chart>JSON</chart> tags (primary) OR ```chart/json code fences (fallback)
  const regex = /<chart>([\s\S]*?)<\/chart>|```(?:chart|json)\s*\n([\s\S]*?)\n```/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(normalizedText)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: normalizedText.slice(lastIndex, match.index) })
    }
    try {
      const jsonStr = match[1] || match[2] // match[1] for <chart>, match[2] for code fence
      const config = JSON.parse(jsonStr) as ChartConfig
      if (config.type && (config.data || config.type === 'gauge')) {
        const isSuggestion = config.suggest === true
        segments.push({ type: 'chart', content: match[0], config, isSuggestion })
      } else {
        segments.push({ type: 'text', content: match[0] })
      }
    } catch {
      segments.push({ type: 'text', content: match[0] })
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < normalizedText.length) {
    segments.push({ type: 'text', content: normalizedText.slice(lastIndex) })
  }

  return { segments }
}
