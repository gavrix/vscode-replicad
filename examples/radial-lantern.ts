import { makeBaseBox, makeCylinder } from 'replicad';

export const defaultParams = {
  height: 68,
  outerRadius: 28,
  wall: 3,
  windows: 12,
  ribs: 6,
};

export default function main(params = defaultParams) {
  const { height, outerRadius, wall, windows, ribs } = params;

  const innerRadius = outerRadius - wall;
  const bandHeight = 8;
  const slotHeight = height - bandHeight * 2 - 8;
  const slotWidth = 9;
  const ribWidth = 4;
  const ribDepth = 3;

  // Base shell
  let lantern = makeCylinder(outerRadius, height).cut(makeCylinder(innerRadius, height + 2, [0, 0, -1]));

  // Top and bottom bands make the silhouette less boring.
  lantern = lantern
    .fuse(makeCylinder(outerRadius + 2, bandHeight, [0, 0, 0]).cut(makeCylinder(innerRadius - 1, bandHeight + 2, [0, 0, -1])))
    .fuse(
      makeCylinder(outerRadius + 2, bandHeight, [0, 0, height - bandHeight]).cut(
        makeCylinder(innerRadius - 1, bandHeight + 2, [0, 0, height - bandHeight - 1])
      )
    );

  // One simple slot, copied around the Z axis.
  const slot = makeBaseBox(slotWidth, wall + 8, slotHeight).translate(
    -slotWidth / 2,
    innerRadius - 4,
    bandHeight + 4
  );

  for (let i = 0; i < windows; i += 1) {
    lantern = lantern.cut(slot.clone().rotate((360 / windows) * i, [0, 0, 0], [0, 0, 1]));
  }

  // Small portholes near the top band add detail without making the code unreadable.
  const porthole = makeCylinder(2.2, wall + 10, [0, innerRadius - 5, height - bandHeight - 6], [0, 1, 0]);

  for (let i = 0; i < windows * 2; i += 1) {
    lantern = lantern.cut(porthole.clone().rotate((360 / (windows * 2)) * i, [0, 0, 0], [0, 0, 1]));
  }

  // External ribs make the preview look richer from every angle.
  const rib = makeBaseBox(ribWidth, ribDepth, height - 10).translate(
    -ribWidth / 2,
    outerRadius - ribDepth / 2,
    5
  );

  for (let i = 0; i < ribs; i += 1) {
    lantern = lantern.fuse(rib.clone().rotate((360 / ribs) * i, [0, 0, 0], [0, 0, 1]));
  }

  return [
    {
      shape: lantern,
      name: 'Radial lantern',
      color: '#4798e9',
    },
  ];
}
