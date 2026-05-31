/* Generates RC Manager app icons (PNG) with no external libraries.
   Run:  node make-icons.js   →  icon-192.png, icon-512.png  */
const fs = require("fs");
const zlib = require("zlib");

/* ---- CRC32 ---- */
const crcTable = (()=>{
  const t = new Uint32Array(256);
  for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320 ^ (c>>>1) : c>>>1; t[n]=c>>>0; }
  return t;
})();
function crc32(buf){
  let c = 0xffffffff;
  for(let i=0;i<buf.length;i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c>>>8);
  return (c ^ 0xffffffff)>>>0;
}
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length,0);
  const typeBuf = Buffer.from(type,"ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf,data])),0);
  return Buffer.concat([len,typeBuf,data,crc]);
}

/* ---- geometry helpers ---- */
function inRoundRect(x,y,x0,y0,w,h,r){
  const x1=x0+w, y1=y0+h;
  if(x<x0||x>x1||y<y0||y>y1) return false;
  if(x<x0+r && y<y0+r) return (x-(x0+r))**2+(y-(y0+r))**2 <= r*r;
  if(x>x1-r && y<y0+r) return (x-(x1-r))**2+(y-(y0+r))**2 <= r*r;
  if(x<x0+r && y>y1-r) return (x-(x0+r))**2+(y-(y1-r))**2 <= r*r;
  if(x>x1-r && y>y1-r) return (x-(x1-r))**2+(y-(y1-r))**2 <= r*r;
  return true;
}
function inCircle(x,y,cx,cy,rad){ return (x-cx)**2+(y-cy)**2 <= rad*rad; }
function distSeg(px,py,ax,ay,bx,by){
  const dx=bx-ax, dy=by-ay; const l2=dx*dx+dy*dy;
  let t = l2? ((px-ax)*dx+(py-ay)*dy)/l2 : 0; t=Math.max(0,Math.min(1,t));
  const cx=ax+t*dx, cy=ay+t*dy; return Math.hypot(px-cx,py-cy);
}

function makeIcon(N){
  const raw = Buffer.alloc(N*(N*4+1)); // each row: 1 filter byte + N*4
  const set = (x,y,r,g,b,a=255)=>{
    const rowStart = y*(N*4+1);
    const i = rowStart + 1 + x*4;
    raw[i]=r; raw[i+1]=g; raw[i+2]=b; raw[i+3]=a;
  };
  const f = v=>v*N;
  // colors
  const dark=[28,32,54];      // wheels / accents
  const white=[255,255,255];
  for(let y=0;y<N;y++){
    for(let x=0;x<N;x++){
      // diagonal gradient background #5b6cff -> #7c4dff
      const t=(x+y)/(2*N);
      let r=Math.round(91+(124-91)*t);
      let g=Math.round(108+(77-108)*t);
      let b=Math.round(255+(255-255)*t);
      // wheels (drawn under body)
      if(inCircle(x,y,f(.36),f(.70),f(.085))||inCircle(x,y,f(.64),f(.70),f(.085))){ [r,g,b]=dark; }
      // car body (lower)
      if(inRoundRect(x,y,f(.18),f(.50),f(.64),f(.17),f(.06))){ [r,g,b]=white; }
      // roof / cabin (upper)
      if(inRoundRect(x,y,f(.33),f(.39),f(.30),f(.14),f(.05))){ [r,g,b]=white; }
      // window slit (cut into roof)
      if(inRoundRect(x,y,f(.37),f(.42),f(.22),f(.07),f(.03))){
        const tt=(x+y)/(2*N);
        r=Math.round(91+(124-91)*tt); g=Math.round(108+(77-108)*tt); b=255;
      }
      // wheel hubs
      if(inCircle(x,y,f(.36),f(.70),f(.032))||inCircle(x,y,f(.64),f(.70),f(.032))){ [r,g,b]=white; }
      // antenna (RC) + tip ball
      if(distSeg(x,y,f(.64),f(.41),f(.80),f(.24))<=f(.014)){ [r,g,b]=white; }
      if(inCircle(x,y,f(.80),f(.24),f(.045))){ [r,g,b]=white; }
      set(x,y,r,g,b,255);
    }
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N,0); ihdr.writeUInt32BE(N,4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  const idat = zlib.deflateSync(raw, {level:9});
  return Buffer.concat([sig, chunk("IHDR",ihdr), chunk("IDAT",idat), chunk("IEND",Buffer.alloc(0))]);
}

fs.writeFileSync("icon-192.png", makeIcon(192));
fs.writeFileSync("icon-512.png", makeIcon(512));
console.log("Icons written: icon-192.png, icon-512.png");
