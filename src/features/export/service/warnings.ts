// Warning shapes shared by the document renderers (Word and PDF).

/** A logo the renderer cannot draw (for example an SVG in Word or PDF): it is left out. */
export interface LogoOmittedWarning {
  code: "logoOmitted";
  where: { part: "letterhead" };
  source: string;
}
