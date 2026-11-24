/**
 * A drawing of the page as a PNG to keep ("Save as picture" of the year card), without a library: the SVG is copied,
 * every colour it takes from the theme (`var(--…)`) written into the copy as it shows now, the copy drawn onto a
 * canvas and saved. Only plain SVG (no HTML inside), so the browser draws it as it is.
 */

/** The attributes of an SVG element that may name a colour of the theme, and the style each one ends up as. */
const PAINTED: [attribute: string, style: string][] = [
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['stop-color', 'stop-color'],
]

/**
 * A copy of `svg` that needs nothing of the page: each painted attribute that reads a variable gets the colour the
 * browser worked out for the original element.
 */
export function standalone(svg: SVGSVGElement): SVGSVGElement {
  const copy = svg.cloneNode(true) as SVGSVGElement
  const originals = [svg, ...svg.querySelectorAll('*')]
  const copies = [copy, ...copy.querySelectorAll('*')]
  originals.forEach((element, index) => {
    const twin = copies[index]
    const shown = getComputedStyle(element)
    for (const [attribute, style] of PAINTED) {
      const value = element.getAttribute(attribute)
      if (value?.includes('var(')) twin.setAttribute(attribute, shown.getPropertyValue(style) || value)
    }
  })
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  copy.removeAttribute('class')
  copy.removeAttribute('style')
  return copy
}

/** Draws `svg` at `width` × `height` pixels and hands the PNG to the browser to save as `name`. */
export async function savePicture(svg: SVGSVGElement, width: number, height: number, name: string): Promise<void> {
  const copy = standalone(svg)
  copy.setAttribute('width', String(width))
  copy.setAttribute('height', String(height))
  const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy))
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('picture'))
    image.src = source
  })
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('picture')
  context.drawImage(image, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('picture')
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
