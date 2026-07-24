import {
  Camera,
  Home,
  Play,
  Search,
  SlidersHorizontal,
  UploadCloud,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

export function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const currentQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(currentQuery);

  useEffect(() => setQuery(currentQuery), [currentQuery]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const targetPath = location.pathname.startsWith("/photos") ? "/photos" : "/";
    const next = query.trim();
    navigate(next ? `${targetPath}?q=${encodeURIComponent(next)}` : targetPath);
  };

  return (
    <header className="site-header">
      <div className="header-inner">
        <NavLink to="/" className="brand" aria-label="映集首页">
          <span className="brand-mark">
            <Play size={17} fill="currentColor" />
          </span>
          <span>映集</span>
        </NavLink>

        <form className="search-box" onSubmit={submit} role="search">
          <Search size={19} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索你的影像"
            aria-label="搜索媒体名称"
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              onClick={() => {
                setQuery("");
                const targetPath = location.pathname.startsWith("/photos")
                  ? "/photos"
                  : "/";
                navigate(targetPath);
              }}
            >
              清除
            </button>
          )}
        </form>

        <nav className="desktop-nav" aria-label="主导航">
          <NavLink to="/" end>
            <Home size={18} />
            视频
          </NavLink>
          <NavLink to="/photos">
            <Camera size={18} />
            照片
          </NavLink>
          <NavLink to="/admin" className="admin-link">
            <UploadCloud size={18} />
            管理
          </NavLink>
        </nav>

        <NavLink to="/admin" className="mobile-admin" aria-label="打开管理后台">
          <SlidersHorizontal size={20} />
        </NavLink>
      </div>
    </header>
  );
}
