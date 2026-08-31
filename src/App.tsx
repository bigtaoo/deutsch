import { SettingsPage } from './pages/SettingsPage';

// 这一阶段只接了数据层 + 备份/GitHub 连接，还没有课程相关的界面（导入/切句/跟读等在后续步骤）。
// 直接渲染设置页，方便现在就能手动走一遍 §10 里备份相关的验收项。
function App() {
  return <SettingsPage />;
}

export default App;
