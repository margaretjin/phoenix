"""혈비 재정 장부 API

- finance_ledger      : 수동 입력 장부 (날짜 · 항목 · 수입 · 지출 · 개당가격 · 수량 · 비품 · 비고)
- finance_categories  : 항목 목록 (수입/지출/기록용, 구입 시 연결되는 비품)
- finance_supplies    : 비품 목록 (카오개 · 마돌 · 미스릴화살 · 엔줄 …)
- finance_supply_moves: 비품 사용(출) / 입고 / 재고조정 기록
  ※ 비품 구입은 장부 행(수량 + 비품)으로만 기록 → 재고 = 장부 구입수량 + 입고 - 사용

분배 관련 자동 기록(혈비 20% · 혈귀속 · 분배금지급)은 보스탐 기록에서 화면이 바로 계산한다.
그래서 따로 저장하지 않아 분배 정보를 고쳐도 장부가 항상 맞는다.
"""
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from database import supabase
from utils import first_or_404, require_admin

router = APIRouter(prefix="/api/finance", tags=["Finance"])

KINDS = {"income", "expense", "none"}
AUTO_START_KEY = "finance_auto_start"
DEFAULT_AUTO_START = "2026-11-24"   # 구글 시트에서 옮긴 마지막 날짜(11/23) 다음 날부터 자동 집계


class LedgerPayload(BaseModel):
    entry_date: str
    category: str
    kind: str                        # income | expense | none
    amount: int = 0
    unit_price: Optional[float] = 0
    quantity: Optional[float] = 0
    supply_name: Optional[str] = ""
    memo: Optional[str] = ""
    requester_role: str
    requester_id: Optional[str] = ""


class CategoryPayload(BaseModel):
    name: str
    kind: str
    supply_name: Optional[str] = ""
    requester_role: str


class SupplyPayload(BaseModel):
    name: str
    unit: Optional[str] = "개"
    requester_role: str


class MovePayload(BaseModel):
    supply_name: str
    move_date: str
    qty_in: float = 0
    qty_out: float = 0
    memo: Optional[str] = ""
    requester_role: str
    requester_id: Optional[str] = ""


class AutoStartPayload(BaseModel):
    date: str
    requester_role: str


def _ledger_row(p: LedgerPayload) -> dict:
    if p.kind not in KINDS:
        raise HTTPException(status_code=400, detail="수입/지출 구분이 올바르지 않습니다.")
    if not p.entry_date or not p.category.strip():
        raise HTTPException(status_code=400, detail="날짜와 항목을 입력해 주세요.")
    unit_price = max(0.0, float(p.unit_price or 0))
    quantity = max(0.0, float(p.quantity or 0))
    amount = max(0, int(p.amount or 0))
    if amount == 0 and unit_price and quantity:
        amount = int(round(unit_price * quantity))   # 금액을 비우면 개당가격 × 수량
    return {
        "entry_date": p.entry_date,
        "category": p.category.strip(),
        "income": amount if p.kind == "income" else 0,
        "expense": amount if p.kind == "expense" else 0,
        "unit_price": unit_price,
        "quantity": quantity,
        "supply_name": (p.supply_name or "").strip(),
        "memo": (p.memo or "").strip(),
        "created_by": p.requester_id or ""
    }


def _get_auto_start() -> str:
    try:
        res = supabase.table("clan_settings").select("setting_value").eq("setting_key", AUTO_START_KEY).execute()
        if res.data and res.data[0].get("setting_value"):
            return str(res.data[0]["setting_value"])
    except Exception:
        pass
    return DEFAULT_AUTO_START


# ---------------------------------------------------------------------------
# 조회 (페이지 1회 로딩)
# ---------------------------------------------------------------------------
@router.get("")
def get_finance():
    def rows(table, *orders):
        q = supabase.table(table).select("*")
        for col in orders:
            q = q.order(col)
        return q.execute().data or []

    return {
        "ledger": rows("finance_ledger", "entry_date", "id"),
        "categories": rows("finance_categories", "sort_order", "id"),
        "supplies": rows("finance_supplies", "sort_order", "id"),
        "moves": rows("finance_supply_moves", "move_date", "id"),
        "auto_start": _get_auto_start()
    }


# ---------------------------------------------------------------------------
# 장부
# ---------------------------------------------------------------------------
@router.post("/ledger")
def create_ledger(p: LedgerPayload):
    require_admin(p.requester_role, "관리자만 재정을 기록할 수 있습니다.")
    res = supabase.table("finance_ledger").insert(_ledger_row(p)).execute()
    return {"status": "created", "data": (res.data or [None])[0]}


@router.put("/ledger/{row_id}")
def update_ledger(row_id: int, p: LedgerPayload):
    require_admin(p.requester_role, "관리자만 재정을 수정할 수 있습니다.")
    row = _ledger_row(p)
    row.pop("created_by", None)
    res = supabase.table("finance_ledger").update(row).eq("id", row_id).execute()
    first_or_404(res, "장부 내역을 찾을 수 없습니다.")
    return {"status": "updated"}


@router.delete("/ledger/{row_id}")
def delete_ledger(row_id: int, requester_role: str):
    require_admin(requester_role)
    supabase.table("finance_ledger").delete().eq("id", row_id).execute()
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# 항목 / 비품 / 비품 입출 / 자동집계 시작일
# ---------------------------------------------------------------------------
@router.post("/categories")
def create_category(p: CategoryPayload):
    require_admin(p.requester_role)
    name = p.name.strip()
    if not name or p.kind not in KINDS:
        raise HTTPException(status_code=400, detail="항목명과 구분(수입/지출)을 확인해 주세요.")
    if supabase.table("finance_categories").select("id").eq("name", name).execute().data:
        raise HTTPException(status_code=400, detail="이미 있는 항목입니다.")
    supabase.table("finance_categories").insert({
        "name": name, "kind": p.kind, "supply_name": (p.supply_name or "").strip(), "sort_order": 99
    }).execute()
    return {"status": "created"}


@router.delete("/categories/{cat_id}")
def delete_category(cat_id: int, requester_role: str):
    require_admin(requester_role)
    supabase.table("finance_categories").delete().eq("id", cat_id).execute()
    return {"status": "deleted"}


@router.post("/supplies")
def create_supply(p: SupplyPayload):
    require_admin(p.requester_role)
    name = p.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="비품 이름을 입력해 주세요.")
    if supabase.table("finance_supplies").select("id").eq("name", name).execute().data:
        raise HTTPException(status_code=400, detail="이미 있는 비품입니다.")
    supabase.table("finance_supplies").insert({"name": name, "unit": (p.unit or "개").strip() or "개", "sort_order": 99}).execute()
    return {"status": "created"}


@router.delete("/supplies/{supply_id}")
def delete_supply(supply_id: int, requester_role: str):
    require_admin(requester_role)
    supabase.table("finance_supplies").delete().eq("id", supply_id).execute()
    return {"status": "deleted"}


@router.post("/moves")
def create_move(p: MovePayload):
    require_admin(p.requester_role)
    if not p.supply_name.strip() or not p.move_date:
        raise HTTPException(status_code=400, detail="비품과 날짜를 입력해 주세요.")
    if (p.qty_in or 0) < 0 or (p.qty_out or 0) < 0 or not (p.qty_in or p.qty_out):
        raise HTTPException(status_code=400, detail="입고 또는 사용 수량을 입력해 주세요.")
    supabase.table("finance_supply_moves").insert({
        "supply_name": p.supply_name.strip(),
        "move_date": p.move_date,
        "qty_in": float(p.qty_in or 0),
        "qty_out": float(p.qty_out or 0),
        "memo": (p.memo or "").strip(),
        "created_by": p.requester_id or ""
    }).execute()
    return {"status": "created"}


@router.delete("/moves/{move_id}")
def delete_move(move_id: int, requester_role: str):
    require_admin(requester_role)
    supabase.table("finance_supply_moves").delete().eq("id", move_id).execute()
    return {"status": "deleted"}


@router.post("/auto-start")
def set_auto_start(p: AutoStartPayload):
    require_admin(p.requester_role)
    supabase.table("clan_settings").upsert({"setting_key": AUTO_START_KEY, "setting_value": p.date}).execute()
    return {"status": "updated", "auto_start": p.date}
