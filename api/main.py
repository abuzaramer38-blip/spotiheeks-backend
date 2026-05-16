import os
import re
import base64
import requests
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

def fetch_spotify_metadata(url_type, track_id, token):
    url = f"https://api.spotify.com/v1/{url_type}s/{track_id}"
    headers = {"Authorization": f"Bearer {token}"}
    res = requests.get(url, headers=headers)
    
    if res.status_code == 200:
        data = res.json()
        if url_type == 'track':
            title = data.get("name")
            artist = data.get("artists")[0].get("name") if data.get("artists") else "Unknown"
            cover_image = data.get("album", {}).get("images", [{}])[0].get("url", "")
            duration_ms = data.get("duration_ms", 0)
            return {
                "type": "track",
                "title": title,
                "artist": artist,
                "cover": cover_image,
                "duration": duration_ms,
                "query": f"{title} {artist} audio"
            }
    return None

class InfoRequest(BaseModel):
    url: str

# Claude ki main.js is endpoint (/api/info) ko dhoond rahi hai
@app.post("/api/info")
async def get_info(request: InfoRequest):
    token = get_spotify_token()
    if not token:
        raise HTTPException(status_code=500, detail="Spotify Auth Failed")
    
    match = re.search(r"open\.spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)", request.url)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid Spotify URL structure")
        
    url_type = match.group(1)
    track_id = match.group(2)
    
    # Abhi track handle karte hain jo main feature hai
    metadata = fetch_spotify_metadata(url_type, track_id, token)
    if not metadata:
        raise HTTPException(status_code=404, detail="Track data not found")
        
    return JSONResponse(metadata)

# Claude ki main.js download ke liye POST request bhejti hai json body ke sath
class DownloadRequest(BaseModel):
    query: str
    title: str = "audio"

@app.post("/api/download")
async def download_track(request: DownloadRequest):
    ydl_opts = {
        'format': 'bestaudio/best',
        'default_search': 'ytsearch',
        'noplaylist': True,
        'quiet': True,
        'skip_download': True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch:{request.query}", download=False)
            if not info or 'entries' not in info or len(info['entries']) == 0:
                raise HTTPException(status_code=404, detail="Audio track not found")
                
            video_info = info['entries'][0]
            audio_url = video_info.get('url')
            
            return JSONResponse({
                "success": True,
                "url": audio_url,
                "title": f"{request.title}.mp3"
            })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
