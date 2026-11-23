from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from routers import auth_router, raid_router, admin_router, item_router, meta_router, bid_router, finance_router

app = FastAPI(title="혈맹 보스탐 체크기")
app.add_middleware(GZipMiddleware, minimum_size=500)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


class CachedStaticFiles(StaticFiles):
    """?v= 버전이 붙은 정적 파일은 1년 캐시 (파일이 바뀌면 버전이 바뀌므로 안전)"""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200 and b"v=" in scope.get("query_string", b""):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


app.mount("/static", CachedStaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def asset(filename: str) -> str:
    """템플릿용 정적 파일 URL. 파일 수정 시각을 버전으로 붙여 수동 ?v= 관리가 필요 없다."""
    try:
        version = int((STATIC_DIR / filename).stat().st_mtime)
    except OSError:
        version = 0
    return f"/static/{filename}?v={version}"


templates.env.globals["asset"] = asset

for r in (auth_router, raid_router, admin_router, item_router, meta_router, bid_router, finance_router):
    app.include_router(r.router)

# URL 경로 → 템플릿 파일
PAGES = {
    "/login": "login.html",
    "/raid-record": "raid_record.html",
    "/raid-status": "raid_status.html",
    "/item-status": "item_status.html",
    "/distribution": "distribution.html",
    "/my-history": "my_history.html",
    "/attendance": "attendance.html",
    "/bids": "bids.html",
    "/finance": "finance.html",
    "/admin": "admin.html",
    "/member-list": "member_list.html",
    "/item-manage": "item_manage.html",
}


def _page_handler(template_name: str):
    async def handler(request: Request):
        return templates.TemplateResponse(request, template_name, {})
    return handler


for url, tpl in PAGES.items():
    app.add_api_route(url, _page_handler(tpl), methods=["GET"], response_class=HTMLResponse, include_in_schema=False)


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/login")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
