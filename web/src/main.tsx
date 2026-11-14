import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import App from './App'
import './styles/index.css'

/** antd 暗色主题：token 对齐 tailwind.config.js 里的 ink / fg / pos / neg / acc */
const antdTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#58a6ff',
    colorBgBase: '#0f1419',
    colorBgContainer: '#171d26',
    colorBgElevated: '#1e2530',
    colorBorder: '#2a3441',
    colorBorderSecondary: '#202833',
    colorText: '#e6edf3',
    colorTextSecondary: '#8b98a5',
    colorTextTertiary: '#6b7885',
    colorSuccess: '#3fb950',
    colorError: '#f85149',
    colorWarning: '#d29922',
    borderRadius: 6,
    fontSize: 13,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, sans-serif',
  },
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* hashPriority=high：避免 Tailwind preflight 覆盖 antd 的 CSS-in-JS 样式 */}
    <StyleProvider hashPriority="high">
      <ConfigProvider theme={antdTheme}>
        <App />
      </ConfigProvider>
    </StyleProvider>
  </React.StrictMode>,
)
