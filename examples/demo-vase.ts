import { drawCircle, drawPolysides, polysideInnerRadius } from 'replicad';

export const defaultParams = {
  height: 120,
  radius: 36,
  sides: 10,
  twistTurns: 5,
  wall: 2.2,
};

export default function main({ height, radius, sides, twistTurns, wall } = defaultParams) {
  const twistAngle = (360 / sides) * twistTurns;

  let vase = drawPolysides(radius, sides, 2)
    .blueprint
    .sketchOnPlane()
    .extrude(height, {
      twistAngle,
      extrusionProfile: { profile: 's-curve', endFactor: 1.4 },
    })
    .fillet(4, (e) => e.inPlane('XY'));

  const innerRadius = polysideInnerRadius(radius, sides, -2) - wall;

  const core = drawCircle(innerRadius)
    .blueprint
    .sketchOnPlane()
    .extrude(height - wall, {
      extrusionProfile: { profile: 's-curve', endFactor: 1.4 },
    })
    .fillet(Math.max(1, 4 - wall), (e) => e.inPlane('XY'))
    .translateZ(wall);

  vase = vase.cut(core);

  return {
    shape: vase,
    name: 'Twisted vase',
    color: '#439bf3',
  };
}
