"""페이지 초기 로딩용 묶음 API.

페이지마다 따로 호출하던 혈비율 / 아이템 목록 / 회원 명단을 한 번의 요청으로 돌려준다.
세 조회는 서로 독립이라 스레드로 동시에 실행해 응답 시간을 줄인다.
(기존 /api/raids/tax-rate, /api/items, /api/auth/search-members 는 그대로 유지)
"""
from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter

from routers.auth_router import search_members
from routers.item_router import fetch_items
from routers.raid_router import get_global_tax_rate

router = APIRouter(prefix="/api", tags=["Meta"])
_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="meta")


@router.get("/meta")
def get_meta():
    f_tax = _pool.submit(get_global_tax_rate)
    f_items = _pool.submit(fetch_items)
    f_members = _pool.submit(search_members, "")
    return {
        "tax_rate": f_tax.result(),
        "items": f_items.result(),
        "members": f_members.result()
    }
