const ENGAGEMENT_ANGLES = [0.58, -0.58, 0.92, -0.92, 0.34, -0.34];
const ENGAGEMENT_RADII = [0.64, 0.72, 0.58, 0.68, 0.76, 0.61];

export function engagementPlan(index, attackRange) {
  const slot = Math.abs(Math.trunc(Number(index) || 0));
  const range = Math.max(1, Number(attackRange) || 1);
  return {
    angle: ENGAGEMENT_ANGLES[slot % ENGAGEMENT_ANGLES.length],
    radius: range * ENGAGEMENT_RADII[slot % ENGAGEMENT_RADII.length],
  };
}

export function enemyShotSpread(distance, {
  playerSpeed = 0,
  shooterSpeed = 0,
  suppressed = false,
  aimConvergence = 1,
} = {}) {
  const range = Math.max(0, Number(distance) || 0);
  const targetMovement = Math.max(0, Number(playerSpeed) || 0);
  const ownMovement = Math.max(0, Number(shooterSpeed) || 0);
  const convergence = Math.max(0, Math.min(1, Number(aimConvergence) || 0));
  return 18 + range * 0.045 + targetMovement * 0.04 + ownMovement * 0.05 +
    // T6's normal-difficulty bot_get_aim_error returns 20 and
    // bot_update_lookat scales that error down as convergence approaches 1.
    (suppressed ? 18 : 0) + (1 - convergence) * 20;
}
