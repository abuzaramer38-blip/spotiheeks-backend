import os
import re
import base64
import requests
import asyncio
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import yt_dlp

app = FastAPI(title="SpotiHeeks Downloader API")

# CORS config taake aapki WordPress site is se connect ho sake
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SPOTIFY_CLIENT_ID = "1697c046b92146e29b69af2870861687"
SPOTIFY_CLIENT_SECRET = "66ef0cd879a444269934c67b632c61b3"

def get_spotify_token():
    auth_string = f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}"
    auth_base64 = base64.b64encode(auth_string.encode("utf-8")).decode("utf-8")
    url = "https://accounts.spotify.com/api/token"
    headers = {
        "Authorization": f"Basic {auth_base64}",
        "Content-Type": "application/x-www-form-urlencoded"
    }
    data = {"grant_type": "client_credentials"}
    res = requests.post(url, headers=headers, data=data)
    if res.status_code == 200:
        return res.json().get("access_token")
    return None

def fetch_spotify_metadata(spotify_url, token):
    match = re.search(r"track/([a-zA-Z0-9]+)", spotify_url)
    if not match:
        return None
    track_id = match.group(1)
    
    url = f"https://api.spotify.com/v1/tracks/{track_id}"
    headers = {"Authorization": f"Bearer {token}"}
    res = requests.get(url, headers=headers)
    
    if res.status_code == 200:
        data = res.json()
        title = data.get("name")
        artist = data.get("artists")[0].get("name") if data.get("artists") else "Unknown"
        cover_image = data.get("album", {}).get("images", [{}])[0].get("url", "")
        return {"title": title, "artist": artist, "cover": cover_image, "query": f"{title} {artist} audio"}
    return None

class TrackRequest(BaseModel):
    url: str

@app.post("/api/analyze")
async def analyze_track(request: TrackRequest):
    token = get_spotify_token()
    if not token:
        raise HTTPException(status_code=500, detail="Spotify API authentication failed")
    
    metadata = fetch_spotify_metadata(request.url, token)
    if not metadata:
        raise HTTPException(status_code=400, detail="Invalid Spotify Link")
    
    return metadata

@app.get("/api/download")
async def download_track(q: str = Query(...)):
    ydl_opts = {
        'format': 'bestaudio/best',
        'default_search': 'ytsearch',
        'noplaylist': True,
        'quiet': True,
    }
    try:
        loop = asyncio.get_event_loop()
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = await loop.run_in_executor(None, lambda: ydl.extract_info(f"ytsearch:{q}", download=False))
            if not info or 'entries' not in info or len(info['entries']) == 0:
                raise HTTPException(status_code=404, detail="Audio not found")
                
            video_info = info['entries'][0]
            audio_url = video_info.get('url')
            title = video_info.get('title', 'audio')
            
            return JSONResponse({
                "download_url": audio_url,
                "title": f"{title}.mp3"
            })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))