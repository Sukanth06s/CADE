export const ROVER_CONFIG = {
  dimensionsCm: {
    length: 27,
    width: 16.5,
    wheelDiameter: 6.5,
    trackWidth: 13.4,
    frontCentreToWheelAxle: 7.05
  },
  encoder: {
    centimetresPerPulse: 0.582
  },
  ultrasonic: {
    left: { angleDegrees: 45, offsetFromFrontCentreCm: 5.5 },
    front: { angleDegrees: 0, offsetFromFrontCentreCm: 0 },
    right: { angleDegrees: -45, offsetFromFrontCentreCm: 5.5 }
  },
  coordinateConvention:
    "Frontend map uses centimetres, pose reference at front-centre, heading 0 faces +Y, positive rotation is counter-clockwise. Future ROS/Gazebo adapters must transform explicitly."
} as const;

export const STUB_NOTICE = "STUB MODE - TEST DATA, NOT PHYSICS SIMULATION";
