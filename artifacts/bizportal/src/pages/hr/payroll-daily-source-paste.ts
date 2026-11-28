import {buildDailySalarySourcePreview,type DailySalarySourceRow} from "./payroll-daily-source-reference";
type NumberMode="raw"|"id"|"en";
const heading=["NO","NAMA","UANG MAKAN","HARI KERJA","PERSENTASE","TOTAL SALARY"];
function amount(text:string,mode:NumberMode,optional:boolean):string|null{
  const raw=text.trim().replace(/^Rp\s*/i,"");
  if(!raw&&optional)return null;
  const pat=mode==="id"?/^(?:[0-9]+|[0-9]{1,3}(?:\.[0-9]{3})+)(?:,[0-9]+)?$/
    :mode==="en"?/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?$/
    :/^[0-9]+(?:\.[0-9]+)?$/;
  if(!pat.test(raw))throw Error("FORMAT_NOMINAL_TIDAK_VALID");
  const plain=mode==="id"?raw.replaceAll(".","").replace(",","."):mode==="en"?raw.replaceAll(",",""):raw;
  const [whole,fraction]=plain.split(".");
  return whole.replace(/^0+(?=\d)/,"")+(fraction===undefined?"":"."+fraction);
}
export function previewDailySourcePaste(text:string,mode:NumberMode,year:number,month:number){
  if(text.length>100000)throw Error("SUMBER_TERLALU_BESAR");
  const source:DailySalarySourceRow[]=[], sourceRows:number[]=[];
  let hasHeader=false;
  for(const [i,line] of text.replace(/\r/g,"").split("\n").entries()){
    const cells=line.split("\t").map(v=>v.trim());
    if(cells.every(x=>!x))continue;
    if(cells.length>6)throw Error("SALIN_HANYA_KOLOM_A_F");
    while(cells.length<6)cells.push("");
    if(cells[0].toUpperCase()==="NO"){
      if(!heading.every((label,j)=>cells[j].toUpperCase()===label))throw Error("JUDUL_KOLOM_TIDAK_SESUAI");
      hasHeader=true;continue;
    }
    if(!hasHeader)throw Error("SERTAKAN_JUDUL_KOLOM");
    if(cells[0].toUpperCase()==="TOTAL")continue;
    if(!/^[1-9][0-9]*$/.test(cells[0]))throw Error("BARIS_SUMBER_TIDAK_VALID_"+(i+1));
    if(cells[3]&&!/^[0-9]{1,2}$/.test(cells[3]))throw Error("HARI_KERJA_TIDAK_VALID_"+(i+1));
    source.push({
      employeeLabel:cells[1],mealAllowanceReference:amount(cells[2],mode,true),
      workDaysReference:cells[3]?Number(cells[3]):null,
      dailyRateReference:amount(cells[4],mode,true),
      totalSalaryReference:amount(cells[5],mode,false)!,
    });
    sourceRows.push(i+1);
  }
  const result=buildDailySalarySourcePreview(source,year,month);
  return {...result,rows:result.rows.map((row,i)=>({...row,rowNumber:sourceRows[i]}))};
}
