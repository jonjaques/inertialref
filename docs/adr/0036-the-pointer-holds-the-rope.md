# ADR-0036: The pointer holds a spring rope whose launch chooses the landing site

Status: accepted · 6 Sep 2026. Supersedes the preview gesture in
[ADR-0034](0034-the-drop.md); the camera descent and surface arm remain as specified there.

## Context

A dragged figure needs to stay under the pointer. A figure held on the local
vertical above a selected latitude moves away from the hand, and its straight
fall gives little indication of depth. The interaction calls for a curved
launch from the hand toward the body, with a flexible connection to the place
where that launch reaches the ground.

The preview and release also need one coordinate owner. React can retain a
hit/miss flag while the pointer crosses a valid region, but a coordinate kept
in that same state stops updating with the visible marker.

## Decision

**Pin the held end to the pointer, integrate a launch to choose the surface
endpoint, and draw a damped spring chain between them.**

The browser unprojects the pointer onto an eye-facing plane in front of the
drawn body. Its placement and orientation convert that point to body radii in
body-fixed axes. This uses the body's compression, so projecting the held end
back through the camera returns the original pointer pixel.

`launchArc` integrates an inward and upward launch under inverse-square
gravity. Its adaptive step follows the local orbital timescale, keeping distant
launches bounded in cost. The transverse speed limits angular momentum below a
grazing orbit's, so the launch reaches the unit sphere. The observatory converts
that contact to latitude and longitude and places the endpoint at the drawn
surface plus eye height.

`SpringRope` resamples the launch by arc length into 33 particles. Neighboring
particles exert spring forces; damped attraction to the launch curve supplies
its bending shape. The solver takes fixed 1/120-second steps, bounded to eight
per presented frame. Both endpoints are pinned exactly; only the interior has
inertia. Reduced motion follows the equilibrium curve immediately.

The observatory owns the landing coordinate. Release reads that owner before
clearing the gesture. Pointer cancellation, lost capture, and a target change
cannot commit a drop, and another pointer cannot take over the gesture.

The held figure and destination have distinct marks. Lines have pixel widths;
the ground ring has a dark keyline for clouds and snow. Orbit traces and labels
recede during aiming and descent through a temporary presentation stance, then
return. Descent feedback shows height, progress, and a return-to-orbit action.

## Alternatives considered

**Move the figure above a directly selected latitude.** This supplies a radial
fall but separates the held figure from the pointer.

**Draw a static Bézier curve.** This gives an arch without inertia or tension.
A spring chain responds to pointer motion while its pinned endpoints retain
precise meaning.

**Let the rope's moving endpoint decide release.** This makes landing depend
on whether the springs have settled. The destination is pinned to the launch
contact, so the camera arrives at the visible marker even during motion.

## Consequences

The pointer, marker, and camera arrival agree, and the curve responds to the
hand without changing canonical simulation state. Tests compare camera
positions with preview endpoints on Earth and Phobos, check spring behavior at
30, 60, and 120 frames per second, and project the held end back to browser
pixels.

The launch is an aiming model in normalized body units. It contacts the datum
sphere before the observatory adjusts the endpoint to the drawn surface; it is
not a simulation of terrain collisions along a physical tether. The camera
flies from its own position to the same destination, rather than jumping to the
pointer to follow the rope. Choosing a site therefore means inspecting the
surface marker, rather than placing the pointer directly on that site.
