import {decode} from "jpeg-js";

/** Recognize a standard left chevron, not merely any top-left dark pixels.
 * The inset point stays inside its standard 44pt hit area; the thin outer
 * stroke proved unreliable on arm 04. No match means no guessed tap. */
export function visibleInsetBackPoint(bytes: Buffer): {x:number;y:number} | null {
  const image=decode(bytes,{useTArray:true,formatAsRGBA:true,maxResolutionInMP:3});
  if(image.width!==720 || image.height!==1560) return null;
  const gray=(x:number,y:number)=>{
    const i=(y*image.width+x)*4;
    return (image.data[i]+image.data[i+1]+image.data[i+2])/3;
  };
  const background=(gray(8,80)+gray(65,80)+gray(8,165)+gray(65,165))/4;
  const mask=new Set<number>();
  for(let y=90;y<=155;y++)for(let x=8;x<=61;x++){
    const contrast=background>128?background-gray(x,y):gray(x,y)-background;
    // Camera exposure can mute iOS blue even when the arrow outline is clear.
    const i = (y * image.width + x) * 4;
    const blueChevron = background > 128 && contrast > 50 && image.data[i + 2] - image.data[i] > 35;
    if (contrast > 90 || blueChevron) mask.add(y * 720 + x);
  }
  const components:number[][]=[];
  while(mask.size){const start=mask.values().next().value!;mask.delete(start);const component=[start];
    for(let i=0;i<component.length;i++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const next=component[i]+dy*720+dx;if(mask.delete(next))component.push(next);
    }components.push(component);
  }
  const matches=components.filter(c=>{
    const ys=c.map(n=>Math.floor(n/720)),xs=c.map(n=>n%720);
    const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
    const w=right-left+1,h=bottom-top+1;
    if(w<12 || w>34 || h<25 || h>48 || c.length/(w*h)>0.55)return false;
    const mean=(low:number,high:number)=>{const section=c.filter(n=>{const y=Math.floor(n/720);return y>=top+low*h&&y<=top+high*h});return section.reduce((s,n)=>s+n%720,0)/section.length;};
    return mean(0,0.25)>mean(0.4,0.6)+5 && mean(0.75,1)>mean(0.4,0.6)+5;
  });
  if (matches.length !== 1) return null;
  // In dark mode a blue iOS Back label offers a larger hit area than the thin icon.
  // Use its vertical center only when the neighboring text is actually visible.
  const rows = matches[0].map(pixel => Math.floor(pixel / 720));
  const centerY = Math.round((Math.min(...rows) + Math.max(...rows)) / 2);
  if (background < 96) {
    let blueColumns = 0;
    for (let x = 70; x <= 120; x++) {
      for (let y = centerY - 12; y <= centerY + 12; y++) {
        const i = (y * image.width + x) * 4;
        if (image.data[i + 2] > 100 && image.data[i + 2] - image.data[i] > 65) {
          blueColumns++;
          break;
        }
      }
    }
    if (blueColumns >= 16) return { x: 95, y: centerY };
  }
  return { x: 60, y: 150 };
}
