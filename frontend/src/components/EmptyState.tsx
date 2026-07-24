import { ImagePlus } from "lucide-react";
import { Link } from "react-router-dom";

interface Props {
  searching: boolean;
  type: "视频" | "照片";
}

export function EmptyState({ searching, type }: Props) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <ImagePlus size={30} />
      </span>
      <h2>{searching ? `没有找到相关${type}` : `还没有${type}`}</h2>
      <p>
        {searching
          ? "换一个关键词试试看。"
          : `去管理后台上传你的第一份${type}吧。`}
      </p>
      {!searching && (
        <Link to="/admin" className="primary-button">
          前往上传
        </Link>
      )}
    </div>
  );
}
