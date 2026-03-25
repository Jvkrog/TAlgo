"use strict";
const { ALMA_LENGTH, ALMA_OFFSET, ALMA_SIGMA, ATR_LENGTH } = require("../core/state");

function heikinAshi(data){
    const ha=[];
    for(let i=0;i<data.length;i++){const c=data[i];
        ha.push(i===0?{open:(c.open+c.close)/2,close:(c.open+c.high+c.low+c.close)/4}
                     :{open:(ha[i-1].open+ha[i-1].close)/2,close:(c.open+c.high+c.low+c.close)/4});}
    return ha;
}

function ema(values,length){
    const k=2/(length+1);let prev=values[0];const r=[prev];
    for(let i=1;i<values.length;i++){prev=values[i]*k+prev*(1-k);r.push(prev);}return r;
}

function alma(values){
    const m=ALMA_OFFSET*(ALMA_LENGTH-1),s=ALMA_LENGTH/ALMA_SIGMA,r=[];
    for(let i=ALMA_LENGTH-1;i<values.length;i++){
        let sum=0,norm=0;
        for(let j=0;j<ALMA_LENGTH;j++){const w=Math.exp(-((j-m)**2)/(2*s*s));sum+=values[i-ALMA_LENGTH+1+j]*w;norm+=w;}
        r.push(sum/norm);}return r;
}

function atr(data){
    const trs=[];
    for(let i=1;i<data.length;i++){const{high,low}=data[i],pc=data[i-1].close;
        trs.push(Math.max(high-low,Math.abs(high-pc),Math.abs(low-pc)));}
    return trs.slice(-ATR_LENGTH).reduce((a,b)=>a+b,0)/ATR_LENGTH;
}

module.exports = { heikinAshi, ema, alma, atr };
