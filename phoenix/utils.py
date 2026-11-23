"""라우터 공통 헬퍼 (권한 체크 / 문자열 정리)"""
from typing import Iterable, List, Optional
from fastapi import HTTPException

SUPER_ADMIN = "슈퍼관리자"
ADMIN_ROLES = {SUPER_ADMIN, "관리자"}
CLASSES = ["기사", "요정", "법사", "군주", "다크엘프"]


def is_admin(role: Optional[str]) -> bool:
    return (role or "").strip() in ADMIN_ROLES


def require_admin(role: Optional[str], detail: str = "관리자 권한이 없습니다.") -> None:
    if not is_admin(role):
        raise HTTPException(status_code=403, detail=detail)


def require_super(role: Optional[str], detail: str = "슈퍼관리자만 가능합니다.") -> None:
    if (role or "").strip() != SUPER_ADMIN:
        raise HTTPException(status_code=403, detail=detail)


def split_csv(raw: Optional[str], limit: Optional[int] = None) -> List[str]:
    """콤마(전각 포함) 구분 문자열 → 공백 제거된 리스트"""
    parts = [p.strip() for p in (raw or "").replace("，", ",").split(",") if p.strip()]
    return parts[:limit] if limit else parts


def join_csv(parts: Iterable[str]) -> str:
    return ", ".join(parts)


def first_or_404(res, detail: str = "데이터를 찾을 수 없습니다.") -> dict:
    if not res.data:
        raise HTTPException(status_code=404, detail=detail)
    return res.data[0]
