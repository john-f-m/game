// Which sprite frame to show for each viewing angle. The angle is measured
// from the direction the boss is facing to the camera: 0 = we see their
// front, 90 = we see their right side (they face screen-right), 180 = back.
// Each view is [degrees, frame index, mirror?]. Frames are the processed
// images in static/sprites/<id>/<id>_<n>.png (see tools/process-sprites.mjs).
//
// height is in wall units (a wall is 1.0 tall).

export const BOSS_SPRITES = {
  eddie: {
    frameCount: 8,
    height: 0.8,
    views: [[0, 1], [45, 0], [90, 0], [135, 6], [180, 5], [225, 4], [270, 3], [315, 2]],
    portrait: 1,
  },
  clifton: {
    frameCount: 6,
    height: 0.78,
    views: [[0, 1], [60, 0], [120, 3], [180, 4], [240, 5], [300, 2]],
    portrait: 1,
  },
};

export const spritePath = (id, i) => `sprites/${id}/${id}_${i}.png`;
