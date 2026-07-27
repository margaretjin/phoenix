import os
import traceback
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter()
_get_all_rows_func = None

def init_dungeon_router(get_all_rows_fn):
    global _get_all_rows_func
    _get_all_rows_func = get_all_rows_fn

@router.get("/kurtz.html")
def kurtz():
    return FileResponse("kurtz.html")

@router.get("/fire.html")
def fire():
    return FileResponse("fire.html")

@router.get("/dragon.html")
def dragon():
    return FileResponse("dragon.html")

@router.get("/bloodlines")
def get_bloodlines():
    if not _get_all_rows_func:
        raise HTTPException(status_code=500, detail="데이터 로더가 초기화되지 않았습니다.")
    try:
        rows = _get_all_rows_func()
        bloodlines = []
        seen = set()
        for row in rows[2:]:
            if len(row) <= 12: 
                continue
            name = row[12].strip()
            if not name: 
                continue
            normalized = name.lower()
            if normalized in {"", "혈없음", "혈 없음", "없음", "none", "null", "undefined"}: 
                continue
            if normalized not in seen:
                seen.add(normalized)
                bloodlines.append(name)
        return {"bloodlines": bloodlines}
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="혈 목록 로드 실패")

@router.get("/members/{bloodline}")
def get_bloodline_members(bloodline: str):
    if not bloodline or bloodline.lower() in ["undefined", "없음", ""]:
        return {"bloodline": "없음", "remaining": 40, "members": []}

    if not _get_all_rows_func:
        raise HTTPException(status_code=500, detail="데이터 로더가 초기화되지 않았습니다.")

    try:
        rows = _get_all_rows_func()
        target = bloodline.strip().lower()
        members = []
        for row in rows[2:]:
            if len(row) <= 5: 
                continue
            member_id = row[1].strip()
            member_job = row[3].strip() if len(row) > 3 else ""
            bloodline_val = row[5].strip().lower() if len(row) > 5 else ""
            castle_val = row[6].strip().lower() if len(row) > 6 else ""
            
            if not member_id: 
                continue
            if bloodline_val == target or castle_val == target:
                members.append({"id": member_id, "job": member_job})

        job_order = {"군주": 0, "기사": 1, "요정": 2, "법사": 3}
        members.sort(key=lambda item: (job_order.get(item.get("job", ""), 99), item.get("id", "").lower()))
        
        return {
            "bloodline": bloodline, 
            "remaining": 40 - len(members), 
            "members": members
        }
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="데이터 로드 실패")