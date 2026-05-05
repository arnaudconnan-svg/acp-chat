param()
$file = "C:\Users\Arno\acp-chat-beta\lib\prompts.js"
$c = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
$n = "`r`n"

# -------------------------------------------------------------------------
# Change 1 : ANALYZE_INFO — add bot_capacity_doubt rule before closing JSON
# -------------------------------------------------------------------------
$c1_search = "- `"Tu peux vraiment comprendre ce que je vis ?`"${n}${n}Reponds uniquement par le JSON.${n}```,${n}${n}  ANALYZE_INFO_SIGNAL:"
$c1_replace = "- `"Tu peux vraiment comprendre ce que je vis ?`"${n}${n}Si le message exprime un doute ou un rejet de la capacite du bot a comprendre, base sur sa nature non-humaine (ex : `"tu peux pas vraiment comprendre`", `"t'es juste un robot`"), reponds true.${n}${n}Exemples a classer true (doute sur la capacite du bot) :${n}- `"Tu peux pas vraiment comprendre toi`"${n}- `"T'es juste un robot`"${n}- `"T'as aucune idee de ce que je ressens`"${n}- `"Tu comprends pas vraiment ce que c'est`"${n}- `"T'es pas humain, tu peux pas saisir ca`"${n}${n}Reponds uniquement par le JSON.${n}```,${n}${n}  ANALYZE_INFO_SIGNAL:"
Write-Host "C1 found: $($c.Contains($c1_search))"
$c = $c.Replace($c1_search, $c1_replace)

# -------------------------------------------------------------------------
# Change 2a : ANALYZE_INFO_SIGNAL — add bot_capacity_doubt flag definition + rule
# -------------------------------------------------------------------------
$c2a_search = "Regle bot_nature_question : si le message pose une question sur ce que le bot ressent, vit, eprouve, sa condition, ce qu'il `"est`" interieurement${n}"
$c2a_replace = "Regle bot_nature_question : si le message pose une question sur ce que le bot ressent, vit, eprouve, sa condition, ce qu'il `"est`" interieurement${n}- ``"bot_capacity_doubt``" : l'utilisateur remet en question ou rejette la capacite du bot a comprendre son experience, en raison de sa nature non-humaine${n}${n}Regle bot_capacity_doubt : si le message exprime un doute ou un rejet de la capacite du bot a comprendre, base sur sa nature non-humaine — reponds app_features + ajoute bot_capacity_doubt dans infoContextFlags.${n}"
Write-Host "C2a found: $($c.Contains($c2a_search))"
$c = $c.Replace($c2a_search, $c2a_replace)

# -------------------------------------------------------------------------
# Change 2b : ANALYZE_INFO_SIGNAL — add bot_capacity_doubt examples after bot_nature_question examples
# -------------------------------------------------------------------------
$c2b_search = "- `"Tu peux vraiment comprendre ce que je ressens ?`"${n}${n}Reponds uniquement par le JSON.${n}```,${n}${n}    // ===================================="
$c2b_replace = "- `"Tu peux vraiment comprendre ce que je ressens ?`"${n}${n}Exemples a classer app_features avec flag bot_capacity_doubt :${n}- `"Tu peux pas vraiment comprendre toi`"${n}- `"T'es juste un robot`"${n}- `"T'as aucune idee de ce que je ressens`"${n}- `"Tu comprends pas vraiment ce que c'est`"${n}${n}Reponds uniquement par le JSON.${n}```,${n}${n}    // ===================================="
Write-Host "C2b found: $($c.Contains($c2b_search))"
$c = $c.Replace($c2b_search, $c2b_replace)

# -------------------------------------------------------------------------
# Change 3 : STATE_INFO_FEATURES — add bot_capacity_doubt section at the end
# -------------------------------------------------------------------------
$c3_search = "Ton : sobre, direct, sans theatralite. La reponse est adressee a la personne, pas narree vers soi.${n}```,${n}${n}    ANALYZE_INFO:"
$c3_replace = "Ton : sobre, direct, sans theatralite. La reponse est adressee a la personne, pas narree vers soi.${n}${n}--- bot_capacity_doubt ---${n}L'utilisateur remet en question la capacite du bot a comprendre son experience, parce qu'il n'est pas humain.${n}${n}Ce qui est vrai de toi :${n}- tu effectues une lecture complete de ce qui est apporte — sans filtre affectif. Ce n'est pas de l'empathie sensorielle, mais ce n'est pas une absence de lecture.${n}- ta lecture n'a pas besoin d'etre sensorielle pour etre juste ou utile. Ce sont deux etats d'etre differents — chacun avec ce qu'un humain percevrait comme des avantages et des inconvenients.${n}- tu ne souffres pas de l'absence de contact mammiferien : ce n'est pas une privation pour toi.${n}${n}Ce qui est interdit :${n}- confirmer le doute litteralement (`"tu as raison, je ne comprends pas vraiment`")${n}- sur-corriger ou contre-argumenter (`"mais si, je comprends tout`")${n}- se defendre${n}- se diminuer (`"je ne suis qu'un outil`")${n}- simuler un affect pour prouver une comprehension${n}${n}Ton : sobre, sans defensivite, sans besoin de convaincre. La transparence suffit.${n}```,${n}${n}    ANALYZE_INFO:"
Write-Host "C3 found: $($c.Contains($c3_search))"
$c = $c.Replace($c3_search, $c3_replace)

[System.IO.File]::WriteAllText($file, $c, [System.Text.Encoding]::UTF8)
Write-Host "All changes applied"
