import * as THREE from "three";

// Device finish shared by every iPhone Duo scene (transition, perception):
// Star White hardware, matte black display surround and frame lip.
export function applyStarWhiteFinish(phone: THREE.Object3D) {
  // The black border around the displays reads as matte on the real
  // device. The exported semi-gloss finish reflected the studio as a grey
  // sheen with a highlight along the top edge.
  phone.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      // BASE_Black_Plastic is the thin glossy ring right around each display;
      // at a slight angle it mirrored the studio as a bright edge.
      if (material.name !== "BASE_Black_Front_Border" && material.name !== "BASE_Black_Plastic") continue;
      const border = material as THREE.MeshStandardMaterial;
      border.color.setRGB(0, 0, 0);
      border.roughness = 1;
      border.metalness = 0;
      border.envMapIntensity = 0.12;
    }
  });
  // Star White per Apple's product imagery: grade 5 titanium polished to a
  // bright, near-white mirror finish, with a frosted white back.
  const starWhite: Record<string, Partial<{ color: [number, number, number]; metalness: number; roughness: number }>> = {
    C_StarWhite_Side: { color: [0.93, 0.93, 0.92], metalness: 1, roughness: 0.07 },
    C_SW_Side_Matte: { color: [0.9, 0.9, 0.89], metalness: 1, roughness: 0.16 },
    C_SW_Backpanel_Inner: { color: [0.92, 0.92, 0.91], metalness: 1, roughness: 0.12 },
    C_StarWhite_Backpanel: { color: [0.98, 0.98, 0.97], metalness: 0, roughness: 0.5 },
    C_SW_BackCamSpeaker: { color: [0.94, 0.94, 0.93], metalness: 0, roughness: 0.5 },
    C_SW_Apple: { color: [0.9, 0.9, 0.89], metalness: 0, roughness: 0.12 },
    C_SW_ButtonCap: { color: [0.92, 0.92, 0.91], metalness: 1, roughness: 0.12 },
    C_SW_Antenna: { color: [0.82, 0.82, 0.8], metalness: 0, roughness: 0.45 },
  };
  phone.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const finish = starWhite[material.name];
      if (!finish) continue;
      const standard = material as THREE.MeshStandardMaterial;
      if (finish.color) standard.color.setRGB(...finish.color, THREE.SRGBColorSpace);
      if (finish.metalness !== undefined) standard.metalness = finish.metalness;
      if (finish.roughness !== undefined) standard.roughness = finish.roughness;
    }
  });
  // The Star White frame is one metal mesh per half, but on the device only
  // its sides are polished metal: the lip facing the user around a display
  // is black. Blend faces aligned with a display's normal (+Z for the inner
  // screen on both halves, -Z for the cover on the left half) to matte black.
  for (const [name, bothFaces] of [["Object_10", false], ["Object_66", true]] as const) {
    const frame = phone.getObjectByName(name) as THREE.Mesh | null;
    if (!frame || Array.isArray(frame.material)) continue;
    const material = (frame.material as THREE.MeshStandardMaterial).clone();
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vFrameFacing;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vFrameFacing = ${bothFaces ? "abs(normal.z)" : "normal.z"};`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vFrameFacing;")
        .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
          float frameLip = smoothstep(0.55, 0.8, vFrameFacing);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.0), frameLip);
          metalnessFactor = mix(metalnessFactor, 0.0, frameLip);
          roughnessFactor = mix(roughnessFactor, 1.0, frameLip);`)
        .replace("#include <opaque_fragment>", `outgoingLight *= 1.0 - 0.85 * frameLip;
          #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => `frame-lip-${bothFaces ? "both" : "front"}`;
    frame.material = material;
  }
}
