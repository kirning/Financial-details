/** Tailwind 配置 —— 与旧版页面配色保持一致 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: { 900: '#0f1419', 800: '#171d26', 700: '#1e2530', 600: '#2a3441' },
        fg:  { DEFAULT: '#e6edf3', dim: '#8b98a5', dim2: '#6b7885' },
        pos: '#3fb950', neg: '#f85149', acc: '#58a6ff', warn: '#d29922',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: { '2xs': '0.6875rem' },
    },
  },
  plugins: [],
}