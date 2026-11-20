from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from routers import auth_router, raid_router, admin_router, item_router

app = FastAPI(title="혈맹 보스탐 체크기")

app.add_middleware(GZipMiddleware, minimum_size=500)

BASE_DIR = Path(__file__).resolve().parent

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

app.include_router(auth_router.router)
app.include_router(raid_router.router)
app.include_router(admin_router.router)
app.include_router(item_router.router)

@app.get("/")
async def root():
    return RedirectResponse(url="/login")

@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html", {})

@app.get("/raid-record", response_class=HTMLResponse)
async def raid_record_page(request: Request):
    return templates.TemplateResponse(request, "raid_record.html", {})

@app.get("/raid-status", response_class=HTMLResponse)
async def raid_status_page(request: Request):
    return templates.TemplateResponse(request, "raid_status.html", {})

@app.get("/item-status", response_class=HTMLResponse)
async def item_status_page(request: Request):
    return templates.TemplateResponse(request, "item_status.html", {})

@app.get("/distribution", response_class=HTMLResponse)
async def distribution_page(request: Request):
    return templates.TemplateResponse(request, "distribution.html", {})

@app.get("/my-history", response_class=HTMLResponse)
async def my_history_page(request: Request):
    return templates.TemplateResponse(request, "my_history.html", {})

@app.get("/attendance", response_class=HTMLResponse)
async def attendance_page(request: Request):
    return templates.TemplateResponse(request, "attendance.html", {})

@app.get("/admin", response_class=HTMLResponse)
async def admin_page(request: Request):
    return templates.TemplateResponse(request, "admin.html", {})

@app.get("/member-list", response_class=HTMLResponse)
async def member_list_page(request: Request):
    return templates.TemplateResponse(request, "member_list.html", {})

@app.get("/item-manage", response_class=HTMLResponse)
async def item_manage_page(request: Request):
    return templates.TemplateResponse(request, "item_manage.html", {})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)