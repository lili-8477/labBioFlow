# Single-cell workflow conventions

Before answering any single-cell / spatial / multiomics question, **consult the
matching `sc-*` skill first** — the canonical best-practices references for this
workspace live there. Only fall back to parametric knowledge if no skill fits.

## Skill routing

| Topic | Skill |
| --- | --- |
| Technology choice, raw data, format interop | `sc-introduction` |
| QC, doublets, normalization, HVG, PCA/UMAP | `sc-preprocessing` |
| Clustering, annotation, integration | `sc-clustering-annotation` |
| Pseudotime, RNA velocity, CellRank | `sc-trajectory` |
| Differential expression, composition, GSEA | `sc-differential-expression` |
| pySCENIC, LIANA, NicheNet, CellChat | `sc-grn-communication` |
| Bulk deconvolution (CIBERSORTx, MuSiC, DWLS) | `sc-bulk-deconvolution` |
| scATAC-seq | `sc-atac` |
| Spatial (Visium, MERFISH, Xenium) | `sc-spatial` |
| CITE-seq / ADT | `sc-cite-seq` |
| TCR/BCR repertoire | `sc-immune-repertoire` |
| Multimodal integration (MOFA+, GLUE, WNN) | `sc-multimodal` |
| Reproducibility, containers, pipelines | `sc-reproducibility` |

Invoke via `/sc-<name>` or the Skill tool.

## Code conventions

- Python: prefer scanpy + anndata; tag analysis steps with `adata.uns["step_log"]`.
- R: prefer Seurat v5 and SingleCellExperiment; use `rpy2` only at the Python/R boundary.
- Write scripts (`script.py` / `script.R`), not notebooks, for standard pipelines.
- Put figures in `results/figures/`, processed objects in `results/`.
