import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from tracking import ConservativeTracker

def cup(box=(.2,.2,.5,.8)):
    return {'label':'cup','box':list(box)}
class TrackingTest(unittest.TestCase):
    def test_motion_preserves_id(self):
        t=ConservativeTracker();a=[cup()];t.update(a,'a',0)
        b=[cup((.22,.2,.52,.8))];t.update(b,'a',.3)
        self.assertEqual(a[0]['trackId'],b[0]['trackId'])
    def test_loss_restart_and_source_never_reuse_identity(self):
        t=ConservativeTracker();a=[cup()];t.update(a,'a',0)
        for generation,now in [('a',2),('b',2.2)]:
            b=[cup()];t.update(b,generation,now);self.assertNotEqual(a[0]['trackId'],b[0]['trackId']);a=b
        t.update([],'b',2.4);b=[cup()];t.update(b,'b',2.6);self.assertNotEqual(a[0]['trackId'],b[0]['trackId'])
    def test_overlapping_cups_do_not_inherit_a_confirmed_track(self):
        t=ConservativeTracker();a=[cup()];t.update(a,'a',0)
        b=[cup(),cup((.25,.2,.55,.8))];t.update(b,'a',.3)
        self.assertTrue(all(x['trackId']!=a[0]['trackId'] for x in b))
if __name__=='__main__':unittest.main()
