# CADR — Auto Cut (v1)

## التوافق والتجربة

تم ضبط الحد الأدنى المطلوب إلى CEP 9، وهو runtime المستخدم في Premiere Pro 2020 (الإصدار 14). هذا يوسّع فرصة التشغيل على 2020 وما بعده، لكنه لا يضمن توافق كل الوظائف مع كل إصدار؛ يجب اختبار Auto Cut وAuto Caption داخل Premiere.

## خطوة مهمة قبل التشغيل: ملف CSInterface.js

الملف ده مكتبة رسمية من أدوبي (مش بتاعتنا) وكل إكستنشن CEP محتاجها عشان الواجهة (HTML) تقدر تكلم بريمير.
لازم تحمّله من مصدره الرسمي وتحطه في `client/CSInterface.js`:

https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_9.x/CSInterface.js

(دوس على زرار "Raw" في الصفحة، احفظ الملف باسم CSInterface.js جوه فولدر client)

## خطوات التشغيل للتجربة على جهازك

1. حمّل ffmpeg (لو مش عندك) وحط مساره في خانة "FFmpeg Path" جوه البانل.
2. فعّل Debug Mode في بريمير عشان يقبل إكستنشن مش موقّعة:
   - **Windows:** افتح Registry Editor، روح لـ `HKEY_CURRENT_USER\Software\Adobe\CSXS.9`، اعمل قيمة جديدة String اسمها `PlayerDebugMode` وقيمتها `1`
   - **Mac:** افتح Terminal واكتب:
     `defaults write com.adobe.CSXS.9 PlayerDebugMode 1`
3. انسخ فولدر CADR كله إلى:
   - **Windows:** `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\`
   - **Mac:** `/Library/Application Support/Adobe/CEP/extensions/`
4. افتح بريمير → Window → Extensions → CADR

## إزاي تستخدمه

1. حدد كذا كليب جنب بعض على التايم لاين (Shift+Click)
2. دوس "Refresh Selection" تتأكد إن العدد ظاهر صح
3. اضبط "Minimum Silence" و"Padding" حسب رغبتك
4. دوس "AUTO CUT"

## اللي اتعمل في النسخة دي

- بيشتغل على **كذا كليب محدد مع بعض** مش كليب واحد بس (المشكلة اللي كانت في الكود القديم)
- كل كليب بيتحلل لوحده بـ ffmpeg، والنتائج بترجع لبريمير كلها مع بعض
- القص بيتم من الكليب اللي في الآخر للي في الأول، عشان القصات متأثرش في أماكن بعضها
- الفيديو والصوت بيتقصوا مع بعض تلقائي

## جديد في النسخة دي

**Auto Cut:**
- **PREVIEW SILENCE (MARKERS)**: بيحلل ويحط Markers حمرا على التايم لاين مكان كل سكتة، تراجعها بعينك قبل ما تعمل القص الفعلي.
- **كاش للتحليل**: لو غيّرت الـ Padding بس وضغطت تاني، مش هيعيد نداء ffmpeg من الأول — هياخد النتيجة الخام من الكاش.
- **قص مجمّع**: كل القصات بتتبعت لبريمير في نداء واحد بدل نداء منفصل لكل قصة (أسرع بكتير مع كليبات كتير).
- **Progress bar** حقيقي بدل النص بس.
- **Presets**: احفظ إعدادات Noise/Silence/Padding باسم، واسترجعها تاني وقت ما تحتاجها.

**Auto Caption:**
- **كابشن كلمة بكلمة** (اختياري) بدل سطر كامل — زي كابشنز الريلز/التيك توك.
- **كلمات حشو مخصصة**: تقدر تضيف كلمات بنفسك بالإضافة للقائمة الافتراضية.
- **حذف مجمّع**: اختار كذا كلمة حشو وامسحهم كلهم بنداء واحد بدل واحد واحد.
- **معاينة الـ SRT قابلة للتعديل** قبل ما تستورد الكابشن فعليًا في بريمير.

## لسه ناقص (المرحلة الجاية)

- Waveform بصري حقيقي (مش بس Markers) للـ Silence Preview
- Undo مجمّع لكل عملية Auto Cut دفعة واحدة


## Settings tab and FFmpeg discovery
- يوجد تبويب Settings لإعداد مفاتيح Gemini/Qwen ولون الواجهة وإعدادات Auto Cut وPresets.
- يحاول CADR اكتشاف `tools/ffmpeg/ffmpeg.exe` أولًا ثم المسار المحفوظ وPATH وبعض المسارات الشائعة.
- لتضمين FFmpeg في نسخة التوزيع، ضع نسخة Windows موثوقة من `ffmpeg.exe` في `tools/ffmpeg/ffmpeg.exe` قبل إنشاء ZIP/المثبّت. ملف `ffmpeg.exe` مضمّن في `tools/ffmpeg/ffmpeg.exe` في هذه الحزمة.
- استخدم زر Test FFmpeg للتحقق من الملف التنفيذي.
- مفاتيح Gemini/Qwen تُشفّر عبر Windows DPAPI للمستخدم الحالي قبل حفظها في CEP localStorage، مع محاولة ترحيل المفاتيح القديمة تلقائيًا. يجب اختبار التشفير والترحيل داخل Premiere على Windows قبل التوزيع العام؛ الحماية لا تغطي البرمجيات الخبيثة التي تعمل تحت حساب Windows نفسه.


## Offline License System

نسخة CADR CUT الحالية تحتوي على نظام ترخيص Offline بتوقيع RSA. لا يحتاج النظام إلى Server أو اشتراك شهري.

- كل جهاز يظهر له **Device ID** داخل Settings → License.
- العميل يرسل Device ID للمُصنّع.
- المُصنّع يصدر License Key موقّعًا ويرسله للعميل.
- التحقق يتم محليًا داخل البلجن.
- البلجن يحتوي على Public Key فقط؛ Private Key لا يجب أن يدخل مجلد Plugin أو ملف Setup الخاص بالعميل.
- Auto Cut وAuto Caption وPreview وTranslate وStyled Captions تتطلب ترخيصًا صالحًا.
- الترخيص يمكن أن يكون Lifetime أو بتاريخ انتهاء.

لإصدار التراخيص استخدم مجلد `License_Admin` الموجود في حزمة المطور فقط.
