"""Conservative adjacent-frame association, not object re-identification.
No new inference model or assignment dependency. Ambiguity, loss and source
changes receive new IDs rather than guessing continuity.
"""
def iou(a,b):
    n=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    return n/max(1e-9,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-n)

class ConservativeTracker:
    def __init__(self):
        self.previous=[];self.serial=0;self.generation=None;self.at=None
    def update(self,detections,generation,now):
        if generation!=self.generation or self.at is None or now-self.at>1.5:
            self.previous=[]
        links=[[j for j,p in enumerate(self.previous) if p['label']==d['label'] and iou(p['box'],d['box'])>.5] for d in detections]
        for i,d in enumerate(detections):
            possible=links[i]
            crowded=any(j!=i and x['label']==d['label'] and iou(x['box'],d['box'])>.25 for j,x in enumerate(detections))
            if not crowded and len(possible)==1 and sum(possible[0] in row for row in links)==1:
                d['trackId']=self.previous[possible[0]]['trackId']
            else:
                self.serial+=1;d['trackId']=self.serial
        self.previous=[dict(d) for d in detections];self.generation=generation;self.at=now
