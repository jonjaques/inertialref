import { createContext, useContext } from 'react'

/**
 * Whether every piece of interface is out of the frame.
 *
 * The state a plate is captured in. `Shift+H` puts the panes, the menu, the
 * reticle, the flight strip and the notices away and leaves what is *content* —
 * the sky labels, which are a layer somebody turned on and are as much part of
 * the picture as the orbit traces are.
 *
 * A context rather than a prop, because the pieces are eight components deep in
 * four different trees and threading a boolean through all of them would put a
 * `chromeHidden` in the props of things that draw a planet. It is also not the
 * same gate a cutscene uses: that one unmounts the mode outright, which is
 * right for a scripted scene and wrong here, since it would take the labels
 * with it.
 *
 * Not persisted. Somebody who cleared the frame to take a picture did not mean
 * "and never show me the interface again", and a reload that came back with no
 * controls and no way to ask for them would be indistinguishable from a broken
 * build.
 */
export const ChromeContext = createContext(false)

export const useChromeHidden = (): boolean => useContext(ChromeContext)
