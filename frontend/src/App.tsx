import { Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { AdminPage } from "./pages/AdminPage";
import { PhotoLibrary } from "./pages/PhotoLibrary";
import { VideoLibrary } from "./pages/VideoLibrary";
import { WatchPage } from "./pages/WatchPage";

function NotFound() {
  return (
    <main className="page-shell narrow-message">
      <h1>这个页面不存在</h1>
      <p>地址可能已经改变，请从顶部导航返回媒体库。</p>
    </main>
  );
}

export default function App() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<VideoLibrary />} />
        <Route path="/photos" element={<PhotoLibrary />} />
        <Route path="/watch/:id" element={<WatchPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <footer className="site-footer">
        <span>映集</span>
        <p>你的影像，只在想起时抵达。</p>
      </footer>
    </>
  );
}
